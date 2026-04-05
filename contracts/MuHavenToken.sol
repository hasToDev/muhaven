// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    FHE,
    euint128,
    ebool,
    InEuint128,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IKYCGate} from "./interfaces/IKYCGate.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";

/// @title MuHavenToken
/// @notice fhERC-20 RWA token with encrypted balances, transfers, and approvals.
///         Uses Fhenix CoFHE for all balance/amount operations.
///         Deployed behind an OZ Transparent Proxy.
contract MuHavenToken is Initializable {

    // ── Storage ──────────────────────────────────────────────────────────

    mapping(address => euint128) private _balances;
    mapping(address => mapping(address => euint128)) private _allowances;
    euint128 private _encryptedTotalSupply;

    string private _name;
    string private _symbol;

    address public usdcAddress;
    IKYCGate public kycGate;
    IInvestorRegistry public registry;
    address public owner;
    address public issuer;

    mapping(address => bool) public minters;

    /// @dev Reserved storage for future upgrades
    uint256[50] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner, address indexed spender);
    event KYCGateUpdated(address indexed newGate);
    event IssuerUpdated(address indexed newIssuer);
    event RegistryUpdated(address indexed newRegistry);
    event MinterGranted(address indexed minter);
    event MinterRevoked(address indexed minter);
    event BalanceDecryptRequested(address indexed account);

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error OnlyMinter();
    error RecipientNotKYC();
    error NoBalance();
    error ZeroAddress();

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert OnlyMinter();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address _kycGate,
        address _registry,
        address _issuer,
        address _usdcAddress
    ) external initializer {
        if (_kycGate == address(0) || _registry == address(0) || _issuer == address(0))
            revert ZeroAddress();

        _name = name_;
        _symbol = symbol_;
        kycGate = IKYCGate(_kycGate);
        registry = IInvestorRegistry(_registry);
        issuer = _issuer;
        usdcAddress = _usdcAddress;
        owner = msg.sender;

        minters[_issuer] = true;
        emit MinterGranted(_issuer);
    }

    // ── View helpers ──────────────────────────────────────���──────────────

    function name() external view returns (string memory) { return _name; }
    function symbol() external view returns (string memory) { return _symbol; }
    function decimals() external pure returns (uint8) { return 18; }

    // ── Mint (encrypted input — standard path) ───────────────────────────

    function mint(address to, InEuint128 memory encryptedAmount) external onlyMinter {
        if (!kycGate.isEligible(to)) revert RecipientNotKYC();

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _mintInternal(to, amount);
    }

    // ── Mint (cleartext input — vault path) ──────────────────────────────

    function mintFromVault(address to, uint256 amount) external onlyMinter {
        if (!kycGate.isEligible(to)) revert RecipientNotKYC();

        euint128 encAmount = FHE.asEuint128(amount);
        FHE.allowThis(encAmount);

        _mintInternal(to, encAmount);
    }

    function _mintInternal(address to, euint128 amount) internal {
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], amount);
        } else {
            _balances[to] = amount;
        }
        FHE.allowThis(_balances[to]);

        if (Common.isInitialized(_encryptedTotalSupply)) {
            _encryptedTotalSupply = FHE.add(_encryptedTotalSupply, amount);
        } else {
            _encryptedTotalSupply = amount;
        }
        FHE.allowThis(_encryptedTotalSupply);

        registry.register(to);
        emit Transfer(address(0), to);
    }

    // ── Transfer ─────────────────────────────────────────────────────────

    function transfer(address to, InEuint128 memory encryptedAmount) external {
        if (!kycGate.isEligible(to)) revert RecipientNotKYC();

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        _transfer(msg.sender, to, amount);
    }

    function transferFrom(
        address from,
        address to,
        InEuint128 memory encryptedAmount
    ) external {
        if (!kycGate.isEligible(to)) revert RecipientNotKYC();

        euint128 amount = FHE.asEuint128(encryptedAmount);
        FHE.allowThis(amount);

        // Silent failure: if allowance < amount, effective amount is zero
        ebool allowanceOk = FHE.gte(_allowances[from][msg.sender], amount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 approvedAmount = FHE.select(allowanceOk, amount, zero);
        FHE.allowThis(approvedAmount);

        // Deduct allowance
        _allowances[from][msg.sender] = FHE.sub(_allowances[from][msg.sender], approvedAmount);
        FHE.allowThis(_allowances[from][msg.sender]);

        _transfer(from, to, approvedAmount);
    }

    /// @dev Internal transfer with silent-failure pattern (Pattern 3).
    ///      If sender balance < amount, transfers zero instead of reverting.
    function _transfer(address from, address to, euint128 amount) internal {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        // Silent failure: if balance < amount, transfer zero
        ebool hasEnough = FHE.gte(_balances[from], amount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 transferAmount = FHE.select(hasEnough, amount, zero);
        FHE.allowThis(transferAmount);

        // Update sender balance
        _balances[from] = FHE.sub(_balances[from], transferAmount);
        FHE.allowThis(_balances[from]);

        // Update recipient balance
        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], transferAmount);
        } else {
            _balances[to] = transferAmount;
        }
        FHE.allowThis(_balances[to]);

        registry.register(to);
        emit Transfer(from, to);
    }

    // ── Approve ──────────────────────────────────────────────────────────

    function approve(address spender, InEuint128 memory encryptedAmount) external {
        if (spender == address(0)) revert ZeroAddress();

        euint128 amount = FHE.asEuint128(encryptedAmount);
        _allowances[msg.sender][spender] = amount;
        FHE.allowThis(_allowances[msg.sender][spender]);

        emit Approval(msg.sender, spender);
    }

    // ── Burn (vault unwrap path) ─────────────────────────────────────────

    /// @notice Burns tokens from `from` using cleartext amount. Caller must be a minter (vault).
    ///         Uses silent-failure pattern: if balance < amount, burns zero.
    function burnFromVault(address from, uint256 amount) external onlyMinter {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        euint128 encAmount = FHE.asEuint128(amount);
        FHE.allowThis(encAmount);

        // Silent failure on insufficient balance
        ebool hasEnough = FHE.gte(_balances[from], encAmount);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 burnAmount = FHE.select(hasEnough, encAmount, zero);
        FHE.allowThis(burnAmount);

        _balances[from] = FHE.sub(_balances[from], burnAmount);
        FHE.allowThis(_balances[from]);

        _encryptedTotalSupply = FHE.sub(_encryptedTotalSupply, burnAmount);
        FHE.allowThis(_encryptedTotalSupply);

        emit Transfer(from, address(0));
    }

    // ── Encrypted balance views (for contract-to-contract use) ───────────

    function encryptedBalanceOf(address account) external view returns (euint128) {
        return _balances[account];
    }

    function encryptedTotalSupply() external view returns (euint128) {
        return _encryptedTotalSupply;
    }

    // ── Async decrypt for balance viewing (Pattern: createDecryptTask) ───

    /// @notice Request async decryption of the caller's own balance.
    ///         Result can be read later via getBalanceDecryptResult().
    function requestBalanceDecrypt() external {
        if (!Common.isInitialized(_balances[msg.sender])) revert NoBalance();
        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint128.unwrap(_balances[msg.sender])),
            msg.sender
        );
        emit BalanceDecryptRequested(msg.sender);
    }

    /// @notice Read the async-decrypted balance for an account.
    /// @return result  The decrypted uint128 value (only meaningful if decrypted == true).
    /// @return decrypted  Whether the decryption has completed.
    function getBalanceDecryptResult(address account)
        external
        view
        returns (uint128 result, bool decrypted)
    {
        return FHE.getDecryptResultSafe(_balances[account]);
    }

    // ── Access control — owner functions ────────────────────────────���────

    function grantMinter(address minter) external onlyOwner {
        if (minter == address(0)) revert ZeroAddress();
        minters[minter] = true;
        emit MinterGranted(minter);
    }

    function revokeMinter(address minter) external onlyOwner {
        minters[minter] = false;
        emit MinterRevoked(minter);
    }

    function setKYCGate(address newGate) external onlyOwner {
        if (newGate == address(0)) revert ZeroAddress();
        kycGate = IKYCGate(newGate);
        emit KYCGateUpdated(newGate);
    }

    function setIssuer(address newIssuer) external onlyOwner {
        if (newIssuer == address(0)) revert ZeroAddress();
        issuer = newIssuer;
        emit IssuerUpdated(newIssuer);
    }

    function setRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        registry = IInvestorRegistry(newRegistry);
        emit RegistryUpdated(newRegistry);
    }
}
