// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    FHE,
    euint64,
    InEuint64
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title BenchTarget
/// @notice Minimal CoFHE-aware contract used by Wave 4 P0 latency bench
///         (`scripts/bench/cofhe-decrypt-latency.ts`) to measure end-to-end
///         decrypt latency on Arbitrum Sepolia.
///
/// @dev Deliberately bare-minimum:
///   - Stores one `euint64` handle.
///   - Exposes the handle via `valueHandle()` so the bench script can pass it
///     to either off-chain decrypt path:
///       (a) `cofheClient.decryptForView(handle, FheTypes.Uint64).execute()`
///           — permit-based view decrypt (used on every UI hot-path read).
///       (b) `cofheClient.decryptForTx(handle).withPermit().execute()`
///           — TN-signed decrypt that returns {decryptedValue, signature}
///             which a contract can on-chain-verify via `FHE.checkSignature`.
///             This is the path P6 will use on its breach signal.
///
///   Note: the legacy `ITaskManager.createDecryptTask` + `getDecryptResultSafe`
///   path is **deprecated** and reverts on Arb Sepolia / cofhe-contracts v0.1.3
///   + cofhe SDK v0.5.1. Do not use it in new code. See
///   `MEMORY.md` reference `feedback_fhe_decrypt_pattern`.
///
///   Not upgradeable, not access-controlled — bench-only. **Do NOT deploy
///   alongside the production contract set; deploy ad-hoc from the bench
///   script and discard.**
contract BenchTarget {

    /// @dev Public so callers can pull the raw handle for off-chain decrypts.
    euint64 public valueHandle;

    /// @dev True after `setValue` writes a fresh handle.
    bool public hasValue;

    event ValueSet(address indexed setter);

    /// @notice Encrypt-in, store, grant ACLs.
    ///         - `allowThis(handle)` so the contract itself can re-read it
    ///           from its own state (Rule 1 of `FHE_ACL_CONVENTIONS.md`).
    ///         - `allowSender(handle)` so the caller can decrypt it via
    ///           `cofheClient.decryptForView` / `decryptForTx` (Rule 2).
    function setValue(InEuint64 calldata encV) external {
        euint64 v = FHE.asEuint64(encV);
        FHE.allowThis(v);
        FHE.allowSender(v);
        valueHandle = v;
        hasValue = true;
        emit ValueSet(msg.sender);
    }
}
