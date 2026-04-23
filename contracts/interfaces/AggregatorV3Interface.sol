// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AggregatorV3Interface
/// @notice Minimal Chainlink-compatible aggregator interface. MuHaven consumes
///         this for the Arbitrum L2 Sequencer Uptime Feed (see ADR-014 and
///         `IssuerControlledOracle._isSequencerUp`) — the same shape is used
///         by Chainlink price feeds so a future `ChainlinkPriceOracle` can
///         reuse this interface as-is.
///
/// @dev Declared locally (not pulled from `@chainlink/contracts`) to keep
///      the Wave 3.5 dependency footprint flat. Only `latestRoundData` is
///      consumed today; the other views match the canonical shape so a
///      drop-in swap to the real Chainlink package is safe.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
