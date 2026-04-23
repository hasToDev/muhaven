// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @title MockSequencerUptimeFeed
/// @notice Chainlink L2SequencerUptimeFeed mock for Hardhat / Arb Sepolia
///         test runs. Mirrors the canonical feed's shape: `answer == 0`
///         means sequencer up, `answer == 1` means sequencer down,
///         `startedAt` is the timestamp of the last status transition.
///         Tests drive it via `setStatus(answer, startedAt)` to exercise the
///         grace-window and down-path in
///         `IssuerControlledOracle._isSequencerUp`.
contract MockSequencerUptimeFeed is AggregatorV3Interface {
    uint80 public currentRoundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;

    constructor(int256 initialAnswer, uint256 initialStartedAt) {
        _answer = initialAnswer;
        _startedAt = initialStartedAt;
        _updatedAt = initialStartedAt;
        currentRoundId = 1;
    }

    /// @notice Transition the sequencer status. Bumps `roundId`, re-stamps
    ///         `startedAt` so tests can drive grace-period semantics.
    function setStatus(int256 newAnswer, uint256 newStartedAt) external {
        _answer = newAnswer;
        _startedAt = newStartedAt;
        _updatedAt = newStartedAt;
        unchecked {
            currentRoundId += 1;
        }
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function description() external pure returns (string memory) {
        return "MockSequencerUptimeFeed";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (currentRoundId, _answer, _startedAt, _updatedAt, currentRoundId);
    }
}
