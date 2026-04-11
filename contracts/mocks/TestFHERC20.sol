// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    FHE,
    euint64,
    InEuint64,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IFHERC20} from "../interfaces/IFHERC20.sol";

/// @title TestFHERC20
/// @notice Diagnostic variant of MockPUSDC that adds a toggleable FHE.isAllowed
///         check in the euint64 overload of confidentialTransferFrom — matching
///         the real FHERC20 (ERC-7984) behavior.
///
///         Deploy on testnet to isolate whether the ACL gate is the cause of
///         the confidentialTransferFrom revert against ConfidentialUSDC.
///
///         Toggle `aclCheckEnabled`:
///           - false → same as MockPUSDC (no ACL check, operator only)
///           - true  → matches real FHERC20 (FHE.isAllowed + operator check)
contract TestFHERC20 is IFHERC20 {

    // ── Storage ───────────────────────────────────────────────────────────

    mapping(address => euint64) private _balances;
    euint64 private _totalSupply;
    mapping(address => mapping(address => uint48)) private _operators;

    string public name;
    string public symbol;
    address public admin;

    /// @notice When true, confidentialTransferFrom(euint64) checks FHE.isAllowed
    bool public aclCheckEnabled;

    // ── Errors ────────────────────────────────────────────────────────────

    error NotOperator();
    error NoBalance();
    error UnauthorizedUseOfEncryptedAmount();
    error NotAdmin();

    // ── Constructor ───────────────────────────────────────────────────────

    constructor() {
        name = "Test Confidential Token";
        symbol = "tFHERC20";
        admin = msg.sender;
        aclCheckEnabled = false; // start with ACL check off
    }

    // ── Admin ─────────────────────────────────────────────────────────────

    function setAclCheckEnabled(bool enabled) external {
        if (msg.sender != admin) revert NotAdmin();
        aclCheckEnabled = enabled;
    }

    // ── Mint (test helper) ────────────────────────────────────────────────

    function mint(address to, uint64 amount) external {
        euint64 encAmount = FHE.asEuint64(amount);
        FHE.allowThis(encAmount);

        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], encAmount);
        } else {
            _balances[to] = encAmount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        if (Common.isInitialized(_totalSupply)) {
            _totalSupply = FHE.add(_totalSupply, encAmount);
        } else {
            _totalSupply = encAmount;
        }
        FHE.allowThis(_totalSupply);
    }

    // ── IFHERC20: Encrypted balances ──────────────────────────────────────

    function confidentialBalanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    function confidentialTotalSupply() external view returns (euint64) {
        return _totalSupply;
    }

    // ── IFHERC20: Confidential transfers ──────────────────────────────────

    function confidentialTransfer(address to, InEuint64 memory inValue) external returns (euint64) {
        euint64 amount = FHE.asEuint64(inValue);
        FHE.allowThis(amount);
        return _doTransfer(msg.sender, to, amount);
    }

    function confidentialTransfer(address to, euint64 value) external returns (euint64) {
        if (aclCheckEnabled) {
            if (!FHE.isAllowed(value, msg.sender)) revert UnauthorizedUseOfEncryptedAmount();
        }
        return _doTransfer(msg.sender, to, value);
    }

    /// @notice EOA transferFrom — requires operator approval.
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValues
    ) external returns (euint64) {
        _requireOperator(from, msg.sender);
        euint64 amount = FHE.asEuint64(inValues);
        FHE.allowThis(amount);
        euint64 transferred = _doTransfer(from, to, amount);
        FHE.allowTransient(transferred, msg.sender);
        return transferred;
    }

    /// @notice Contract transferFrom — requires operator approval.
    ///         When aclCheckEnabled is true, also checks FHE.isAllowed
    ///         (matching the real FHERC20 behavior).
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) external returns (euint64) {
        if (aclCheckEnabled) {
            if (!FHE.isAllowed(value, msg.sender)) revert UnauthorizedUseOfEncryptedAmount();
        }
        _requireOperator(from, msg.sender);
        euint64 transferred = _doTransfer(from, to, value);
        FHE.allowTransient(transferred, msg.sender);
        return transferred;
    }

    /// @notice uint256 variant — for compatibility with callers compiled against
    ///         cofhe-contracts where euint64 wraps uint256 (different selector).
    function confidentialTransferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (uint256) {
        euint64 amount = euint64.wrap(bytes32(value));
        if (aclCheckEnabled) {
            if (!FHE.isAllowed(amount, msg.sender)) revert UnauthorizedUseOfEncryptedAmount();
        }
        _requireOperator(from, msg.sender);
        euint64 transferred = _doTransfer(from, to, amount);
        FHE.allowTransient(transferred, msg.sender);
        return uint256(euint64.unwrap(transferred));
    }

    // ── IFHERC20: Operator model ──────────────────────────────────────────

    function setOperator(address operator, uint48 until) external {
        _operators[msg.sender][operator] = until;
    }

    function isOperator(address holder, address spender) external view returns (bool) {
        return _operators[holder][spender] > block.timestamp;
    }

    // ── IFHERC20: Wrap (mock) ─────────────────────────────────────────────

    function wrap(address to, uint256 amount) external {
        uint64 amount64 = uint64(amount);
        euint64 encAmount = FHE.asEuint64(amount64);
        FHE.allowThis(encAmount);

        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], encAmount);
        } else {
            _balances[to] = encAmount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        if (Common.isInitialized(_totalSupply)) {
            _totalSupply = FHE.add(_totalSupply, encAmount);
        } else {
            _totalSupply = encAmount;
        }
        FHE.allowThis(_totalSupply);
    }

    function isFherc20() external pure returns (bool) {
        return true;
    }

    // ── Internal ──────────────────────────────────────────────────────────

    function _doTransfer(address from, address to, euint64 amount) internal returns (euint64) {
        if (!Common.isInitialized(_balances[from])) revert NoBalance();

        _balances[from] = FHE.sub(_balances[from], amount);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);

        if (Common.isInitialized(_balances[to])) {
            _balances[to] = FHE.add(_balances[to], amount);
        } else {
            _balances[to] = amount;
        }
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        return _balances[to];
    }

    function _requireOperator(address holder, address spender) internal view {
        if (_operators[holder][spender] <= block.timestamp) revert NotOperator();
    }
}
