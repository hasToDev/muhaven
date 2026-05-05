// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IKYCGate} from "./interfaces/IKYCGate.sol";

/// @title KYCAttestationRegistry (P11.C stub)
/// @notice Source-chain registry tracking attestation metadata (nonces,
///         revocations, jurisdiction) for cross-chain KYC.
///
///         The actual EIP-712 signing happens off-chain by an authorised
///         backend signer. This contract:
///           - exposes `prepareAttestation` (a view) for the backend to read
///             current KYC status + nonce + jurisdiction;
///           - tracks per-investor monotonic nonces — bumping a nonce
///             invalidates every attestation issued under the previous nonce;
///           - tracks revocation booleans per (investor, nonce) for fine-grained
///             invalidation without touching the live nonce.
///
///         Wave 4 P11 ships as a stub — design + minimal storage + admin
///         primitives. The destination-chain verifier (`MuHavenKYCVerifier`)
///         is the consumer that actually validates EIP-712 signatures.
///
/// @dev Non-proxied — follows the swap pattern of the Wave-3 KYC adapter.
contract KYCAttestationRegistry {

    // ── Structs ──────────────────────────────────────────────────────

    /// @notice Attestation payload prepared for off-chain signing.
    /// @dev Mirrors the EIP-712 typed-data shape that
    ///      `MuHavenKYCVerifier` expects on the destination chain.
    struct AttestationData {
        address investor;
        bool isVerified;
        uint8 tier;                  // 0 = none, 1 = retail, 2 = accredited
        bytes32 jurisdictionHash;    // keccak256("US"), keccak256("EU"), …
        uint256 nonce;
        uint256 issuedAt;
        uint256 expiresAt;
    }

    // ── Storage ──────────────────────────────────────────────────────

    /// @notice Underlying KYC gate (Wave 3 ERC3643KYCAdapter or any IKYCGate).
    IKYCGate public kycGate;

    /// @notice Address whose private key signs EIP-712 attestations off-chain.
    address public attestationSigner;

    /// @notice Default validity window for newly prepared attestations.
    uint256 public defaultValidityPeriod;

    /// @notice Per-investor monotonic nonce. Bumping invalidates earlier
    ///         attestations issued under the previous value.
    mapping(address => uint256) public nonces;

    /// @notice (investor, nonce) → revoked.
    mapping(address => mapping(uint256 => bool)) public revoked;

    /// @notice Per-investor jurisdiction hash (admin-set).
    mapping(address => bytes32) public jurisdictionHashes;

    address public admin;

    // ── Events ───────────────────────────────────────────────────────

    event AttestationRevoked(address indexed investor, uint256 nonce, uint256 newNonce);
    event JurisdictionUpdated(address indexed investor, bytes32 jurisdictionHash);
    event AttestationSignerUpdated(address indexed newSigner);
    event ValidityPeriodUpdated(uint256 newPeriod);
    event KycGateUpdated(address indexed newGate);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ── Errors ───────────────────────────────────────────────────────

    error OnlyAdmin();
    error ZeroAddress();
    error LengthMismatch();
    error InvalidValidityPeriod();

    // ── Modifiers ────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────

    constructor(
        address _kycGate,
        address _signer,
        address _admin,
        uint256 _defaultValidityPeriod
    ) {
        if (_kycGate == address(0) || _signer == address(0) || _admin == address(0))
            revert ZeroAddress();
        if (_defaultValidityPeriod == 0) revert InvalidValidityPeriod();
        kycGate = IKYCGate(_kycGate);
        attestationSigner = _signer;
        admin = _admin;
        defaultValidityPeriod = _defaultValidityPeriod;
    }

    // ── Functions ────────────────────────────────────────────────────

    /// @notice Read current attestation data for `investor`. Pure view —
    ///         the backend signs the returned struct off-chain. Does NOT
    ///         increment the nonce.
    function prepareAttestation(address investor)
        external
        view
        returns (AttestationData memory)
    {
        bool verified = kycGate.isEligible(investor);
        uint8 tier = 0;
        if (verified) {
            // Tier resolution: 2 if accredited, else 1 if KYC.
            if (kycGate.isEligibleForTier(investor, 2)) {
                tier = 2;
            } else {
                tier = 1;
            }
        }
        uint256 issuedAt = block.timestamp;
        return AttestationData({
            investor:         investor,
            isVerified:       verified,
            tier:             tier,
            jurisdictionHash: jurisdictionHashes[investor],
            nonce:            nonces[investor],
            issuedAt:         issuedAt,
            expiresAt:        issuedAt + defaultValidityPeriod
        });
    }

    /// @notice Revoke the investor's currently-active attestation by
    ///         marking the prior nonce as revoked AND bumping the live
    ///         nonce so future attestations sit at a new index. The bump
    ///         is what destination-chain verifiers see (and what makes
    ///         the next backend `prepareAttestation` use a fresh nonce).
    function revokeAttestation(address investor) external onlyAdmin {
        uint256 currentNonce = nonces[investor];
        revoked[investor][currentNonce] = true;
        uint256 newNonce = currentNonce + 1;
        nonces[investor] = newNonce;
        emit AttestationRevoked(investor, currentNonce, newNonce);
    }

    /// @notice True iff the (investor, nonce) attestation is still
    ///         destination-chain-relevant (not explicitly revoked AND
    ///         not superseded by a newer nonce).
    function isAttestationValid(address investor, uint256 nonce) external view returns (bool) {
        if (revoked[investor][nonce]) return false;
        return nonce >= nonces[investor];
    }

    /// @notice Set the jurisdiction hash for `investor`.
    function setJurisdictionHash(address investor, bytes32 hash) external onlyAdmin {
        if (investor == address(0)) revert ZeroAddress();
        jurisdictionHashes[investor] = hash;
        emit JurisdictionUpdated(investor, hash);
    }

    /// @notice Batch-set jurisdiction hashes.
    function batchSetJurisdictionHash(
        address[] calldata investors,
        bytes32[] calldata hashes
    ) external onlyAdmin {
        if (investors.length != hashes.length) revert LengthMismatch();
        for (uint256 i = 0; i < investors.length; i++) {
            address investor = investors[i];
            if (investor == address(0)) revert ZeroAddress();
            jurisdictionHashes[investor] = hashes[i];
            emit JurisdictionUpdated(investor, hashes[i]);
        }
    }

    function setAttestationSigner(address newSigner) external onlyAdmin {
        if (newSigner == address(0)) revert ZeroAddress();
        attestationSigner = newSigner;
        emit AttestationSignerUpdated(newSigner);
    }

    function setDefaultValidityPeriod(uint256 newPeriod) external onlyAdmin {
        if (newPeriod == 0) revert InvalidValidityPeriod();
        defaultValidityPeriod = newPeriod;
        emit ValidityPeriodUpdated(newPeriod);
    }

    function setKycGate(address newGate) external onlyAdmin {
        if (newGate == address(0)) revert ZeroAddress();
        kycGate = IKYCGate(newGate);
        emit KycGateUpdated(newGate);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
