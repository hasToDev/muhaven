// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";

/// @title MuHavenKYCVerifier (P11.C stub)
/// @notice Destination-chain verifier for MuHaven cross-chain KYC. Implements
///         `IKYCGate` so any protocol can drop this in as its KYC oracle and
///         transparently consume MuHaven-issued attestations.
///
///         Flow:
///           1. Investor obtains an EIP-712-signed attestation from MuHaven's
///              source chain (signed by the backend signer registered on
///              `KYCAttestationRegistry`).
///           2. Investor (or relayer) calls `submitAttestation(...)` with the
///              raw attestation fields plus the signature.
///           3. Verifier `ecrecover`s the signature against the configured
///              `trustedSigner`; if valid + non-expired, caches the result.
///           4. Any protocol calls `isEligible(account)` — returns the
///              cached status.
///
///         No bridge infrastructure required: the attestation travels with
///         the investor as a signed message. Revocation requires explicit
///         `invalidateAttestation` (or natural expiry).
///
/// @dev Non-proxied. Stub-quality for Wave 4 P11; production will harden
///      this with a multi-signer ring + replay protection across chains.
contract MuHavenKYCVerifier is ERC165, IKYCGate {

    using ECDSA for bytes32;

    // ── Structs ──────────────────────────────────────────────────────

    struct CachedAttestation {
        bool isVerified;
        uint8 tier;
        bytes32 jurisdictionHash;
        uint256 nonce;
        uint256 expiresAt;
        uint256 submittedAt;
    }

    // ── EIP-712 constants ────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "KYCAttestation(address investor,bool isVerified,uint8 tier,bytes32 jurisdictionHash,uint256 nonce,uint256 issuedAt,uint256 expiresAt)"
    );

    /// @notice Domain name component. Pinned for stability across upgrades.
    string public constant DOMAIN_NAME = "MuHaven KYC Attestation";
    string public constant DOMAIN_VERSION = "1";

    // ── Storage ──────────────────────────────────────────────────────

    address public trustedSigner;

    /// @notice Pre-computed EIP-712 domain separator for the SOURCE chain
    ///         + source-chain registry. The destination chain doesn't get
    ///         to choose this; it must match what the backend signed.
    bytes32 public sourceDomainSeparator;

    /// @notice Source chain ID (for diagnostics + admin verification).
    uint256 public sourceChainId;

    /// @notice Source-chain registry address (for diagnostics).
    address public sourceRegistry;

    address public admin;

    mapping(address => CachedAttestation) private _cachedAttestations;

    // ── Events ───────────────────────────────────────────────────────

    event AttestationSubmitted(address indexed investor, uint8 tier, uint256 expiresAt);
    event AttestationInvalidated(address indexed investor);
    event TrustedSignerUpdated(address indexed newSigner);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ───────────────────────────────────────────────────────

    error OnlyAdmin();
    error ZeroAddress();
    error InvalidSignature();
    error AttestationExpired();
    error InvestorMismatch();
    error NonceNotMonotonic();

    // ── Modifiers ────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────

    constructor(
        address _trustedSigner,
        uint256 _sourceChainId,
        address _sourceRegistryAddr,
        address _admin
    ) {
        if (
            _trustedSigner == address(0) ||
            _sourceRegistryAddr == address(0) ||
            _admin == address(0)
        ) revert ZeroAddress();

        trustedSigner = _trustedSigner;
        sourceChainId = _sourceChainId;
        sourceRegistry = _sourceRegistryAddr;
        admin = _admin;

        sourceDomainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                _sourceChainId,
                _sourceRegistryAddr
            )
        );
    }

    // ── Public surface ───────────────────────────────────────────────

    /// @notice Submit + verify a signed attestation. Anyone can submit;
    ///         the signature is what gates trust. Overwrites any previous
    ///         cached attestation for the investor.
    ///
    /// @dev Reverts on:
    ///        - signature not from `trustedSigner`
    ///        - `expiresAt` already in the past
    ///        - the attestation is for a different investor than `investor`
    function submitAttestation(
        address investor,
        bool isVerified,
        uint8 tier,
        bytes32 jurisdictionHash,
        uint256 nonce,
        uint256 issuedAt,
        uint256 expiresAt,
        bytes calldata signature
    ) external {
        if (block.timestamp >= expiresAt) revert AttestationExpired();
        // Reject nonce rollback. Re-submitting the same nonce IS allowed
        // (e.g. clock-extending refresh of the cached `expiresAt`); only
        // *strictly older* nonces are blocked. This is a defence-in-depth
        // backstop for the stale-attestation replay path documented in
        // `docs/CREDIT_PROTECTION_DESIGN.md` §7.
        if (nonce < _cachedAttestations[investor].nonce) revert NonceNotMonotonic();

        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                investor,
                isVerified,
                tier,
                jurisdictionHash,
                nonce,
                issuedAt,
                expiresAt
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", sourceDomainSeparator, structHash)
        );
        address recovered = digest.recover(signature);
        if (recovered != trustedSigner) revert InvalidSignature();

        _cachedAttestations[investor] = CachedAttestation({
            isVerified:       isVerified,
            tier:             tier,
            jurisdictionHash: jurisdictionHash,
            nonce:            nonce,
            expiresAt:        expiresAt,
            submittedAt:      block.timestamp
        });

        emit AttestationSubmitted(investor, tier, expiresAt);
    }

    /// @notice Admin-only invalidation (e.g. on revocation broadcast from
    ///         the source chain). Sets the cache to a deny-by-default record
    ///         so any subsequent `isEligible` returns false.
    function invalidateAttestation(address investor) external onlyAdmin {
        delete _cachedAttestations[investor];
        emit AttestationInvalidated(investor);
    }

    // ── IKYCGate ─────────────────────────────────────────────────────

    /// @inheritdoc IKYCGate
    function isEligible(address account) external view returns (bool) {
        CachedAttestation storage c = _cachedAttestations[account];
        if (!c.isVerified) return false;
        if (block.timestamp >= c.expiresAt) return false;
        return true;
    }

    /// @inheritdoc IKYCGate
    /// @dev Tier 1 = retail KYC, tier 2 = accredited.
    function isEligibleForTier(address account, uint256 tier) external view returns (bool) {
        CachedAttestation storage c = _cachedAttestations[account];
        if (!c.isVerified) return false;
        if (block.timestamp >= c.expiresAt) return false;
        return c.tier >= tier;
    }

    /// @inheritdoc IKYCGate
    function providerName() external pure returns (string memory) {
        return "MuHaven Cross-Chain KYC (EIP-712 Attestation)";
    }

    // ── Views ────────────────────────────────────────────────────────

    function getCachedAttestation(address investor) external view returns (CachedAttestation memory) {
        return _cachedAttestations[investor];
    }

    // ── Admin ────────────────────────────────────────────────────────

    function setTrustedSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert ZeroAddress();
        trustedSigner = newSigner;
        emit TrustedSignerUpdated(newSigner);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ── EIP-165 ──────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IKYCGate).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
