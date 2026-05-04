// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FHE, euint128, InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title ProbeTrivialDiv
/// @notice Empirical probe for Phase 9.C / L1.0 — answers the question
///         "does `FHE.div(handle, trivial)` stall on cofhe TN the way
///         `FHE.div(handle, aggregate)` does in `YieldSnapshot.fundEpoch`?"
///
///         The L1 contract change in Phase 9.C plans to add a
///         `FHE.div(encShare128, trivialScale)` step inside
///         `claimYield` so issuers can fund sub-1:1-yield epochs without
///         losing precision (RATE_SCALE = 1_000_000). The diagnostic
///         model in `COFHE_TN_DIAGNOSTIC_GUIDE.md` flags `FHE.div` as
///         empirically the most failure-prone op — but the failure
///         shape that's been observed (`encRatio = div(_, sum-of-N-balances)`)
///         had an aggregate-fan-in DENOMINATOR. Whether a TRIVIAL
///         denominator triggers the same stall is unknown.
///
///         This probe re-creates the EXACT op shape L1 will introduce:
///         `result = FHE.div(FHE.mul(input, trivialRate), trivialScale)`.
///         The probe script then attempts `decryptForView(result)` on
///         staging; if the request resolves within the SDK's polling
///         budget, L1 is safe to ship; if it 204s indefinitely, fall
///         through to Plan C (defer L1; ship L2 + L3 only).
///
/// @dev   Probe-only contract. Not deployed in the production stack;
///        not added to `deployments/*.json`. Lives under `contracts/
///        probes/` to keep production compilation surface clean.
contract ProbeTrivialDiv {
    /// @notice Latest probe result handle. Read by the probe script
    ///         after `probe()` returns to extract the ctHash for
    ///         `decryptForView`.
    euint128 public lastResult;

    /// @notice Emitted on every successful probe run. The `result`
    ///         handle is also stored in `lastResult` for direct view-
    ///         read fallback if the script can't subscribe to events.
    event ProbeDone(address indexed caller, euint128 result);

    /// @notice Mirror the L1 claimYield op chain on a caller-supplied
    ///         encrypted input.
    /// @param  enc          Encrypted uint128 input (mimics `encBalance`).
    /// @param  fakeRate     Cleartext "rate" — wrapped as a trivial encrypt
    ///                      to mimic Phase 9.B / Option A's `ratePerShare`
    ///                      multiplication.
    /// @param  scale        Cleartext "RATE_SCALE" — wrapped as a trivial
    ///                      encrypt to mimic the L1 div-by-scale step.
    function probe(
        InEuint128 calldata enc,
        uint128 fakeRate,
        uint128 scale
    ) external {
        // Step 1 — input verify. Same shape as `fundEpoch`'s
        //          `FHE.asEuint128(encTotalYield)`.
        euint128 inH = FHE.asEuint128(enc);
        FHE.allowThis(inH);

        // Step 2 — mul by trivial rate. Same shape as `claimYield`'s
        //          `FHE.mul(encBalance, FHE.asEuint128(uint256(ratePerShare)))`.
        euint128 trivialRate = FHE.asEuint128(uint256(fakeRate));
        FHE.allowThis(trivialRate);
        euint128 product = FHE.mul(inH, trivialRate);
        FHE.allowThis(product);

        // Step 3 — div by trivial scale. THE STEP UNDER TEST. Same
        //          shape as L1's `FHE.div(encShare128, FHE.asEuint128(
        //          uint256(RATE_SCALE)))`.
        euint128 trivialScale = FHE.asEuint128(uint256(scale));
        FHE.allowThis(trivialScale);
        euint128 result = FHE.div(product, trivialScale);
        FHE.allowThis(result);

        // Stamp ACL on the result so the caller can decrypt via permit.
        FHE.allow(result, msg.sender);

        lastResult = result;
        emit ProbeDone(msg.sender, result);
    }
}
