// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFunctionsRouter
/// @notice Minimal Chainlink Functions router interface consumed by
///         `ChainlinkFunctionsOracle`. Declared locally — matching the
///         `AggregatorV3Interface` precedent — to keep the Wave 3.5 dependency
///         footprint flat (no Chainlink contracts package import).
///
/// @dev Only `sendRequest` is called today. The CBOR-encoded request body is
///      built off-chain and stored per-token via
///      `ChainlinkFunctionsOracle.setTokenConfig`; the oracle is a pass-through
///      to the router on the transmit path. Fulfillment lands on the consumer
///      via `IFunctionsClient.handleOracleFulfillment`.
///
///      Local interface kept dep-free — matches the `AggregatorV3Interface`
///      precedent — drop-in compatible with the Chainlink contracts package.
interface IFunctionsRouter {
    /// @notice Forward an off-chain computation request to the Chainlink
    ///         Functions DON. Returns a request ID that the subsequent
    ///         fulfillment callback carries so consumers can correlate.
    /// @param subscriptionId     Chainlink Functions subscription ID (pre-funded
    ///                           with LINK on the Functions dashboard).
    /// @param data               CBOR-encoded request body (source + args +
    ///                           secrets). Built off-chain via
    ///                           `FunctionsRequest` SDK helpers.
    /// @param dataVersion        Request schema version — always `1` today.
    /// @param callbackGasLimit   Gas forwarded to the consumer callback.
    /// @param donId              DON identifier (chain-specific).
    /// @return requestId         Unique identifier for this request.
    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId);
}
