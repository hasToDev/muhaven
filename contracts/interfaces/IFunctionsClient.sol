// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFunctionsClient
/// @notice Minimal Chainlink Functions consumer callback interface. The DON's
///         oracle proxy calls `handleOracleFulfillment` on the consumer once
///         off-chain computation completes.
///
/// @dev Declared locally to mirror the `AggregatorV3Interface` pattern and
///      keep the Wave 3.5 footprint dep-free. Drop-in compatible with the
///      FunctionsClient shape shipped in the Chainlink contracts package.
interface IFunctionsClient {
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) external;
}
