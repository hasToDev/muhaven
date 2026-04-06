// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";

/// @title MuHavenVault
/// @notice Locks ERC-20 RWA tokens and mints equivalent fhERC-20 tokens via MuHavenToken.
///         Unwrap burns fhERC-20 (silent-failure pattern) and releases the locked ERC-20.
///         Per-user `_lockedBalances` tracking bounds unwrap to deposited amount, preventing
///         drain if the FHE burn silently fails on insufficient encrypted balance.
///         Deployed behind an OZ Transparent Proxy.
contract MuHavenVault is Initializable, PausableUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ── Storage ──────────────────────────────────────────────────────────

    IERC20 public underlyingToken;
    IMuHavenToken public muhavenToken;
    address public owner;
    uint256 public minInvestment;
    uint256 public totalLocked;

    /// @dev Per-user locked ERC-20 balance. Source of truth for unwrap bounds.
    mapping(address => uint256) private _lockedBalances;

    /// @dev Reserved storage for future upgrades
    uint256[50] private __gap;

    // ── Events ───────────────────────────────────────────────────────────

    event Wrapped(address indexed user, uint256 amount);
    event Unwrapped(address indexed user, uint256 amount);
    event MinInvestmentUpdated(uint256 newMin);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────

    error OnlyOwner();
    error BelowMinimum();
    error ZeroAmount();
    error ExceedsLockedBalance();
    error ZeroAddress();

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _underlyingToken,
        address _muhavenToken,
        uint256 _minInvestment
    ) external initializer {
        if (_underlyingToken == address(0) || _muhavenToken == address(0)) revert ZeroAddress();
        __Pausable_init();
        underlyingToken = IERC20(_underlyingToken);
        muhavenToken = IMuHavenToken(_muhavenToken);
        minInvestment = _minInvestment;
        owner = msg.sender;
    }

    // ── Core ─────────────────────────────────────────────────────────────

    /// @notice Lock ERC-20 tokens and mint equivalent fhERC-20 tokens.
    ///         Caller must approve this vault on the underlying token first.
    ///         KYC eligibility is enforced by MuHavenToken.mintFromVault().
    function wrap(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount < minInvestment) revert BelowMinimum();

        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
        _lockedBalances[msg.sender] += amount;
        totalLocked += amount;

        muhavenToken.mintFromVault(msg.sender, amount);

        emit Wrapped(msg.sender, amount);
    }

    /// @notice Burn fhERC-20 tokens and unlock equivalent ERC-20 tokens.
    ///         The FHE burn uses a silent-failure pattern — it will not revert
    ///         even if the encrypted balance is inconsistent. The vault relies on
    ///         _lockedBalances as the sole source of truth for unwrap eligibility.
    function unwrap(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount > _lockedBalances[msg.sender]) revert ExceedsLockedBalance();

        muhavenToken.burnFromVault(msg.sender, amount);
        _lockedBalances[msg.sender] -= amount;
        totalLocked -= amount;

        underlyingToken.safeTransfer(msg.sender, amount);

        emit Unwrapped(msg.sender, amount);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /// @notice Returns the amount of ERC-20 locked by a user in this vault.
    function getLockedBalance(address user) external view returns (uint256) {
        return _lockedBalances[user];
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setMinInvestment(uint256 newMin) external onlyOwner {
        minInvestment = newMin;
        emit MinInvestmentUpdated(newMin);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
