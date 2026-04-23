// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFunctionsRouter} from "../interfaces/IFunctionsRouter.sol";
import {IFunctionsClient} from "../interfaces/IFunctionsClient.sol";

/// @title MockFunctionsRouter
/// @notice Minimal Chainlink Functions router stand-in for Hardhat tests.
///         Records the last `sendRequest` call for assertion, issues a
///         deterministic `requestId`, and exposes a `fulfillRequest` helper
///         so tests can synchronously drive `handleOracleFulfillment` on
///         `ChainlinkFunctionsOracle` with whatever `response` / `err` they
///         need to exercise.
///
/// @dev NOT production code. The canonical Chainlink Functions router
///      performs access control on `sendRequest`, enforces per-subscription
///      limits, and routes via the DON. This mock is a pass-through so the
///      oracle's transmit + fulfillment paths can be unit-tested without any
///      cross-chain infra.
contract MockFunctionsRouter is IFunctionsRouter {
    uint64 public lastSubscriptionId;
    bytes public lastData;
    uint16 public lastDataVersion;
    uint32 public lastCallbackGasLimit;
    bytes32 public lastDonId;
    bytes32 public lastRequestId;
    address public lastCaller;

    uint256 private _nonce;

    event RequestSent(
        bytes32 indexed requestId,
        address indexed caller,
        uint64 subscriptionId,
        bytes32 donId,
        uint32 callbackGasLimit
    );

    /// @inheritdoc IFunctionsRouter
    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId) {
        unchecked {
            _nonce += 1;
        }
        requestId = keccak256(abi.encode(msg.sender, _nonce, block.chainid));

        lastSubscriptionId = subscriptionId;
        lastData = data;
        lastDataVersion = dataVersion;
        lastCallbackGasLimit = callbackGasLimit;
        lastDonId = donId;
        lastRequestId = requestId;
        lastCaller = msg.sender;

        emit RequestSent(requestId, msg.sender, subscriptionId, donId, callbackGasLimit);
    }

    /// @notice Drive fulfillment back onto the consumer. `response` carries
    ///         the DON-returned payload; `err` is non-empty to simulate a
    ///         DON-side failure.
    function fulfillRequest(
        address consumer,
        bytes32 requestId,
        bytes calldata response,
        bytes calldata err
    ) external {
        IFunctionsClient(consumer).handleOracleFulfillment(requestId, response, err);
    }
}
