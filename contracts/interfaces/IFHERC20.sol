// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IFHERC20
/// @notice Interface for FHERC20 confidential tokens (ReineiraOS standard).
///         Mirrors the real ConfidentialUSDC / FHERC20 interface on Arbitrum Sepolia.
///
///         Key differences from standard ERC-20:
///           - Standard ERC-20 functions (transfer, approve, transferFrom, allowance) REVERT.
///           - Uses `confidentialTransfer` / `confidentialTransferFrom` with encrypted amounts.
///           - Uses time-bounded operator model instead of allowances.
///           - All amounts are `euint64` (sufficient for 6-decimal stablecoins).
///
/// @dev MuHaven uses this interface for PUSDC interaction in the yield pipeline.
///      The YieldDistributor calls `confidentialTransferFrom` (operator model) to pull
///      encrypted PUSDC from the issuer, then widens the `euint64` to `euint128` via
///      `FHE.asEuint128(euint64)` for internal yield accounting.
interface IFHERC20 {
    // ── Encrypted balances ──────────────────────────────────────────────

    /// @notice Returns the encrypted balance of `account`.
    function confidentialBalanceOf(address account) external view returns (euint64);

    /// @notice Returns the encrypted total supply.
    function confidentialTotalSupply() external view returns (euint64);

    // ── Confidential transfers ──────────────────────────────────────────

    /// @notice Transfer encrypted amount to `to`. EOA variant (client-encrypted input).
    function confidentialTransfer(address to, InEuint64 memory inValue) external returns (euint64);

    /// @notice Transfer encrypted amount to `to`. Contract variant (on-chain ciphertext).
    function confidentialTransfer(address to, euint64 value) external returns (euint64);

    /// @notice Transfer from `from` to `to`. EOA variant. Requires operator approval.
    function confidentialTransferFrom(address from, address to, InEuint64 memory inValues) external returns (euint64);

    /// @notice Transfer from `from` to `to`. Contract variant. Requires operator approval.
    function confidentialTransferFrom(address from, address to, euint64 value) external returns (euint64);

    // ── Operator model (replaces ERC-20 allowances) ─────────────────────

    /// @notice Grant `operator` permission to transfer on behalf of caller until `until` timestamp.
    function setOperator(address operator, uint48 until) external;

    /// @notice Check if `spender` is an active operator for `holder`.
    function isOperator(address holder, address spender) external view returns (bool);

    // ── Wrap / unwrap (FHERC20Wrapper) ──────────────────────────────────

    /// @notice Wrap cleartext ERC-20 into confidential token.
    function wrap(address to, uint256 amount) external;

    /// @notice Returns true if this is an FHERC20 token.
    function isFherc20() external view returns (bool);
}
