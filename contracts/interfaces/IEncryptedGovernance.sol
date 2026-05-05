// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title IEncryptedGovernance
/// @notice FHE-encrypted ballot voting. Investors vote on proposals using
///         encrypted ballots — nobody can see individual votes. Vote weight
///         equals the voter's encrypted token balance (read via
///         `IMuHavenToken.getBalanceForGovernance`).
///
///         Primary use case: force-triggering a `DefaultProtection` payout
///         when the issuer is uncooperative.
///
/// @dev See `docs/CREDIT_PROTECTION_DESIGN.md` §4 for the full specification
///      including the FHE-select vote-weight pattern (immune to vote-value
///      manipulation; same gas cost yes/no for side-channel resistance).
interface IEncryptedGovernance {

    // ── Events ───────────────────────────────────────────────────────

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed token,
        uint8 proposalType,
        address indexed proposer,
        uint256 votingEnd
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter);
    event TallyRequested(uint256 indexed proposalId);
    event ProposalExecuted(uint256 indexed proposalId, bool passed);
    event ProposalDefeated(uint256 indexed proposalId);

    event VotingPeriodUpdated(uint256 newPeriodSeconds);
    event QuorumBpsUpdated(uint256 newQuorumBps);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────

    error OnlyOwner();
    error ZeroAddress();
    error InvalidProposal();
    error VotingNotActive();
    error VotingNotEnded();
    error AlreadyVoted();
    error NotRegisteredInvestor();
    error ProposalNotTallyable();
    error TallyNotRequested();
    error TallyNotReady();
    error ProposalAlreadyResolved();
    error InvalidVotingPeriod();
    error InvalidQuorum();
    error NoProtectionForToken();

    // ── Actions ──────────────────────────────────────────────────────

    function createProposal(
        address token,
        uint8 proposalType
    ) external returns (uint256 proposalId);

    function castVote(
        uint256 proposalId,
        InEuint128 memory encryptedVote
    ) external;

    function requestTally(uint256 proposalId) external;

    function executeProposal(uint256 proposalId) external;

    // ── Views ────────────────────────────────────────────────────────

    function getProposal(uint256 proposalId) external view returns (
        address token,
        uint8 proposalType,
        address proposer,
        uint256 votingStart,
        uint256 votingEnd,
        uint256 voterCount,
        uint8 status
    );

    function hasVoted(uint256 proposalId, address voter) external view returns (bool);
    function proposalCount() external view returns (uint256);
    function votingPeriodSeconds() external view returns (uint256);
    function quorumBps() external view returns (uint256);

    // ── Admin ────────────────────────────────────────────────────────

    function setVotingPeriod(uint256 newPeriodSeconds) external;
    function setQuorumBps(uint256 newQuorumBps) external;
    function transferOwnership(address newOwner) external;
}
