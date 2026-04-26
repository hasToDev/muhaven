// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    FHE,
    euint64,
    InEuint64,
    Common
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IFHERC20} from "../interfaces/IFHERC20.sol";

/// @title MockPUSDC
/// @notice Test stand-in for ConfidentialUSDC (ReineiraOS FHERC20 wrapper).
///         Implements the IFHERC20 interface with encrypted balances and the
///         operator model. Uses CoFHE mock infrastructure for local testing.
///
///         NOT production code — replace with real ConfidentialUSDC on testnet.
contract MockPUSDC is IFHERC20 {

    // ── Storage ───────────────────────────────────────────────────────────

    mapping(address => euint64) private _balances;
    euint64 private _totalSupply;

    /// @dev Operator model: holder → operator → expiry timestamp
    mapping(address => mapping(address => uint48)) private _operators;

    string public name;
    string public symbol;

    // ── Errors ────────────────────────────────────────────────────────────

    error NotOperator();
    error NoBalance();

    // ── Constructor ───────────────────────────────────────────────────────

    constructor() {
        name = "Mock Confidential USDC";
        symbol = "cUSDC";
    }

    // ── Mint (test helper — not in IFHERC20) ──────────────────────────────

    /// @notice Mint encrypted cUSDC to `to`. Test-only convenience function
    ///         simulating a wrap from cleartext USDC.
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

    /// @notice EOA transfer — client-encrypted input.
    function confidentialTransfer(address to, InEuint64 memory inValue) external returns (euint64) {
        euint64 amount = FHE.asEuint64(inValue);
        FHE.allowThis(amount);
        return _doTransfer(msg.sender, to, amount);
    }

    /// @notice Contract transfer — on-chain ciphertext handle.
    function confidentialTransfer(address to, euint64 value) external returns (euint64) {
        return _doTransfer(msg.sender, to, value);
    }

    /// @notice uint256 variant of contract transfer — matches the pre-v0.1.0
    ///         ConfidentialUSDC ABI (euint64 wraps uint256). Used by MuHavenEscrow
    ///         via low-level call with selector `confidentialTransfer(address,uint256)`.
    function confidentialTransfer(address to, uint256 value) external returns (uint256) {
        euint64 result = _doTransfer(msg.sender, to, euint64.wrap(bytes32(value)));
        return uint256(euint64.unwrap(result));
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
        return _doTransfer(from, to, amount);
    }

    /// @notice Contract transferFrom — requires operator approval.
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) external returns (euint64) {
        _requireOperator(from, msg.sender);
        return _doTransfer(from, to, value);
    }

    /// @notice uint256 variant — for compatibility with callers compiled against
    ///         cofhe-contracts where euint64 wraps uint256 (different selector).
    function confidentialTransferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (uint256) {
        _requireOperator(from, msg.sender);
        euint64 result = _doTransfer(from, to, euint64.wrap(bytes32(value)));
        return uint256(euint64.unwrap(result));
    }

    // ── Modern-surface shims (Phase 7.6 / ADR-NEW-1) ──────────────────────
    //
    // After Phase 7.6, MuHavenSubscription / RedemptionQueue call PUSDC via
    // the modern `IMuHavenStable.transferFrom(...)` selector exclusively
    // (legacy ADR-008 low-level call dropped). MockPUSDC keeps the legacy
    // selectors above for Wave 3 callers + adds these modern-surface shims
    // so existing test fixtures don't have to wire MuHavenStable on top of
    // MockPUSDC just to deploy.
    //
    // The mock has no silent-fail (legacy IFHERC20 reverts on insufficient
    // balance via underflow; modern wrapper silent-fails to zero), so the
    // shims always return the *requested* amount. That keeps the
    // share/cash silent-fail mirror happy-path consistent: `actualPaid ==
    // encAmount` ⇒ `fullPay = true` ⇒ shares mint as requested. Tests that
    // exercise the silent-fail asymmetry must use the real MuHavenStable
    // wrapper fixture (`deployV2FixtureWithWrapper` /
    // `MuHavenStable.integration.test.ts`).

    /// @notice Modern-surface transferFrom (on-chain handle).
    function transferFrom(
        address from,
        address to,
        euint64 encAmount,
        address /* ephemeralEOA */
    ) external returns (euint64) {
        _requireOperator(from, msg.sender);
        FHE.allowThis(encAmount);
        _doTransfer(from, to, encAmount);
        // No silent-fail on MockPUSDC — actualPaid == encAmount.
        return encAmount;
    }

    /// @notice Modern-surface transferFrom (client-encrypted input).
    function transferFrom(
        address from,
        address to,
        InEuint64 memory encAmount,
        address /* ephemeralEOA */
    ) external returns (euint64) {
        _requireOperator(from, msg.sender);
        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowThis(amount);
        _doTransfer(from, to, amount);
        return amount;
    }

    // ── IFHERC20: Operator model ──────────────────────────────────────────

    function setOperator(address operator, uint48 until) external {
        _operators[msg.sender][operator] = until;
    }

    function isOperator(address holder, address spender) external view returns (bool) {
        return _operators[holder][spender] > block.timestamp;
    }

    // ── IFHERC20: Wrap (simplified for mock) ──────────────────────────────

    /// @notice Mock wrap — just mints the amount. Real ConfidentialUSDC pulls USDC first.
    function wrap(address to, uint256 amount) external {
        // In real ConfidentialUSDC this does safeTransferFrom(msg.sender, ..., amount)
        // then mints encrypted balance. Mock skips the ERC-20 pull.
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

        // Deduct from sender
        _balances[from] = FHE.sub(_balances[from], amount);
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);

        // Credit to recipient
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
