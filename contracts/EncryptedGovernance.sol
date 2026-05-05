// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import {
    FHE,
    ebool,
    euint128,
    InEuint128,
    Common,
    ITaskManager,
    TASK_MANAGER_ADDRESS
} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {IMuHavenToken} from "./interfaces/IMuHavenToken.sol";
import {IInvestorRegistry} from "./interfaces/IInvestorRegistry.sol";
import {IDefaultProtection} from "./interfaces/IDefaultProtection.sol";
import {IEncryptedGovernance} from "./interfaces/IEncryptedGovernance.sol";

/// @title EncryptedGovernance
/// @notice FHE-encrypted ballot voting. Investors vote on proposals using
///         encrypted ballots — individual votes stay private; only the final
///         pass/fail outcome is decrypted (after the voting period ends).
///
///         Vote weight equals the voter's encrypted token balance, read from
///         `MuHavenToken.getBalanceForGovernance`. The vote-weight pattern is
///         `FHE.select(isYes, balance, 0)`, NOT `FHE.mul(vote, balance)`:
///         binary, immune to vote-value manipulation, identical gas cost
///         yes/no for side-channel resistance. See design doc §4 for the
///         rationale.
///
///         Wave 4 carry-over from `docs/CREDIT_PROTECTION_DESIGN.md`. Single
///         executable proposal type (`FORCE_PROTECTION_TRIGGER`); future
///         proposal types extend the enum + the executor switch.
///
///         Deployed behind an OZ Transparent Proxy.
contract EncryptedGovernance is
    Initializable,
    ERC165Upgradeable,
    IEncryptedGovernance
{

    // ── Enums / structs ──────────────────────────────────────────────

    /// @dev Single value for the hackathon. Wave 5 extends with
    ///      DELIST_TOKEN, CHANGE_RISK_PARAMS, etc.
    uint8 public constant PROPOSAL_TYPE_FORCE_PROTECTION_TRIGGER = 0;

    /// @dev ACTIVE → TALLY_REQUESTED → EXECUTED / DEFEATED.
    enum ProposalStatus { ACTIVE, TALLY_REQUESTED, EXECUTED, DEFEATED }

    struct Proposal {
        address token;
        uint256 protectionId;       // Resolved at create time, frozen.
        uint8 proposalType;
        address proposer;
        uint256 votingStart;
        uint256 votingEnd;
        euint128 encTotalYesWeight;
        euint128 encTotalSupplySnapshot;
        euint128 encTallyResult;    // 1 = passed, 0 = defeated
        uint256 voterCount;
        ProposalStatus status;
    }

    // ── Storage ──────────────────────────────────────────────────────

    /// @dev Proposal IDs start at 1.
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) private _hasVoted;
    uint256 public proposalCount;

    uint256 public votingPeriodSeconds;
    uint256 public quorumBps;

    IMuHavenToken public muhavenToken;
    IDefaultProtection public defaultProtection;
    IInvestorRegistry public registry;

    address public owner;

    /// @dev Reserved storage for future upgrades (proxy-safe gap).
    uint256[50] private __gap;

    // ── Modifiers ────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise the proxy.
    /// @param _muhavenToken      Token to read balances + supply from. This
    ///                           contract MUST be authorised via
    ///                           `setAuthorizedReader` before
    ///                           createProposal works.
    /// @param _defaultProtection Default-protection target. This contract
    ///                           MUST be added via `setAuthorizedTrigger`
    ///                           before executeProposal works.
    /// @param _registry          InvestorRegistry — voter eligibility check.
    /// @param _owner             Initial owner.
    /// @param _votingPeriod      Voting period in seconds.
    /// @param _quorumBps         Quorum threshold in bps (0..10000].
    function initialize(
        address _muhavenToken,
        address _defaultProtection,
        address _registry,
        address _owner,
        uint256 _votingPeriod,
        uint256 _quorumBps
    ) external initializer {
        if (
            _muhavenToken == address(0) ||
            _defaultProtection == address(0) ||
            _registry == address(0) ||
            _owner == address(0)
        ) revert ZeroAddress();
        if (_votingPeriod == 0) revert InvalidVotingPeriod();
        if (_quorumBps == 0 || _quorumBps > 10000) revert InvalidQuorum();

        __ERC165_init();
        muhavenToken = IMuHavenToken(_muhavenToken);
        defaultProtection = IDefaultProtection(_defaultProtection);
        registry = IInvestorRegistry(_registry);
        owner = _owner;
        votingPeriodSeconds = _votingPeriod;
        quorumBps = _quorumBps;
    }

    // ── Proposal lifecycle ───────────────────────────────────────────

    /// @inheritdoc IEncryptedGovernance
    /// @dev Proposer must be a registered investor. Token must have an
    ///      active DefaultProtection — the protection ID is captured at
    ///      creation time so the executor doesn't need to re-resolve it.
    function createProposal(
        address token,
        uint8 proposalType
    ) external returns (uint256 proposalId) {
        if (token == address(0)) revert ZeroAddress();
        if (proposalType != PROPOSAL_TYPE_FORCE_PROTECTION_TRIGGER) revert InvalidProposal();
        if (!registry.isInvestor(msg.sender)) revert NotRegisteredInvestor();

        uint256 protectionId = defaultProtection.tokenProtection(token);
        if (protectionId == 0) revert NoProtectionForToken();

        // Re-grant ACL on supply handle so subsequent FHE math (FHE.div /
        // FHE.gte) inside this contract has access. Ditto on the running
        // yes-weight zero handle.
        euint128 supplySnapshot = muhavenToken.getTotalSupplyForGovernance();
        FHE.allowThis(supplySnapshot);

        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.token = token;
        p.protectionId = protectionId;
        p.proposalType = proposalType;
        p.proposer = msg.sender;
        p.votingStart = block.timestamp;
        p.votingEnd = block.timestamp + votingPeriodSeconds;
        p.encTotalYesWeight = zero;
        p.encTotalSupplySnapshot = supplySnapshot;
        p.status = ProposalStatus.ACTIVE;

        emit ProposalCreated(proposalId, token, proposalType, msg.sender, p.votingEnd);
    }

    /// @inheritdoc IEncryptedGovernance
    /// @dev Vote encoding: 0 = no, ≥1 = yes. The `FHE.gte(vote, 1)` predicate
    ///      collapses any nonzero vote to "yes" — vote-value manipulation
    ///      doesn't change the weight. Weight = balance via `FHE.select`,
    ///      so the inner code path is identical for yes / no — same gas,
    ///      same trace per ADR-style side-channel resistance.
    function castVote(
        uint256 proposalId,
        InEuint128 memory encryptedVote
    ) external {
        if (proposalId == 0 || proposalId > proposalCount) revert InvalidProposal();
        Proposal storage p = _proposals[proposalId];
        if (p.status != ProposalStatus.ACTIVE) revert VotingNotActive();
        if (block.timestamp >= p.votingEnd) revert VotingNotActive();
        if (!registry.isInvestor(msg.sender)) revert NotRegisteredInvestor();
        if (_hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        // Mark BEFORE FHE work so a revert in the SDK input verification
        // doesn't leave a "gas-hot but didn't vote" hole. Solidity reverts
        // roll back state too, so the order is cosmetic; readability wins.
        _hasVoted[proposalId][msg.sender] = true;

        // ZK-validate the encrypted ballot.
        euint128 vote = FHE.asEuint128(encryptedVote);
        FHE.allowThis(vote);

        // isYes = (vote >= 1)
        euint128 one = FHE.asEuint128(uint256(1));
        FHE.allowThis(one);
        ebool isYes = FHE.gte(vote, one);
        FHE.allowThis(isYes);

        // Voter balance — re-grants ACL to this contract.
        euint128 balance = muhavenToken.getBalanceForGovernance(msg.sender);
        FHE.allowThis(balance);

        // weightedVote = isYes ? balance : 0
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 weighted = FHE.select(isYes, balance, zero);
        FHE.allowThis(weighted);

        p.encTotalYesWeight = FHE.add(p.encTotalYesWeight, weighted);
        FHE.allowThis(p.encTotalYesWeight);

        p.voterCount++;
        emit VoteCast(proposalId, msg.sender);
    }

    /// @inheritdoc IEncryptedGovernance
    /// @dev Computes `(supplySnapshot / 10000) * quorumBps` as the threshold,
    ///      then submits an async-decrypt task on the encrypted boolean
    ///      result. The cleartext is read in `executeProposal` after the
    ///      coprocessor delay. Rounding-loss in `(x / 10000)` is acceptable
    ///      for quorum thresholds — design choice in the doc to keep the
    ///      math overflow-safe for large supplies.
    function requestTally(uint256 proposalId) external {
        if (proposalId == 0 || proposalId > proposalCount) revert InvalidProposal();
        Proposal storage p = _proposals[proposalId];
        if (p.status != ProposalStatus.ACTIVE) revert ProposalNotTallyable();
        if (block.timestamp < p.votingEnd) revert VotingNotEnded();

        euint128 tenK = FHE.asEuint128(uint256(10000));
        FHE.allowThis(tenK);
        euint128 supplyDiv = FHE.div(p.encTotalSupplySnapshot, tenK);
        FHE.allowThis(supplyDiv);

        euint128 quorum = FHE.asEuint128(quorumBps);
        FHE.allowThis(quorum);
        euint128 threshold = FHE.mul(supplyDiv, quorum);
        FHE.allowThis(threshold);

        ebool passed = FHE.gte(p.encTotalYesWeight, threshold);
        FHE.allowThis(passed);

        euint128 one = FHE.asEuint128(uint256(1));
        FHE.allowThis(one);
        euint128 zero = FHE.asEuint128(uint256(0));
        FHE.allowThis(zero);
        euint128 result = FHE.select(passed, one, zero);
        FHE.allowThis(result);

        p.encTallyResult = result;
        p.status = ProposalStatus.TALLY_REQUESTED;

        ITaskManager(TASK_MANAGER_ADDRESS).createDecryptTask(
            uint256(euint128.unwrap(result)),
            msg.sender
        );

        emit TallyRequested(proposalId);
    }

    /// @inheritdoc IEncryptedGovernance
    /// @dev Reads the async-decrypt result. If passed → triggers the bound
    ///      protection; otherwise records DEFEATED. If `triggerPayout`
    ///      reverts (e.g. the protection was already triggered out-of-band
    ///      or the reserve was empty), this call reverts so the caller
    ///      can investigate; the proposal stays in TALLY_REQUESTED.
    function executeProposal(uint256 proposalId) external {
        if (proposalId == 0 || proposalId > proposalCount) revert InvalidProposal();
        Proposal storage p = _proposals[proposalId];
        if (p.status == ProposalStatus.EXECUTED || p.status == ProposalStatus.DEFEATED) {
            revert ProposalAlreadyResolved();
        }
        if (p.status != ProposalStatus.TALLY_REQUESTED) revert TallyNotRequested();

        (uint128 cleartext, bool ready) = FHE.getDecryptResultSafe(p.encTallyResult);
        if (!ready) revert TallyNotReady();

        if (cleartext == 1) {
            // Passed — trigger the protection. Status flip happens before
            // the external call so a re-entrant trigger can't double-fire.
            p.status = ProposalStatus.EXECUTED;
            defaultProtection.triggerPayout(p.protectionId);
            emit ProposalExecuted(proposalId, true);
        } else {
            p.status = ProposalStatus.DEFEATED;
            emit ProposalExecuted(proposalId, false);
            emit ProposalDefeated(proposalId);
        }
    }

    // ── Views ────────────────────────────────────────────────────────

    /// @inheritdoc IEncryptedGovernance
    function getProposal(uint256 proposalId) external view returns (
        address token,
        uint8 proposalType,
        address proposer,
        uint256 votingStart,
        uint256 votingEnd,
        uint256 voterCount,
        uint8 status
    ) {
        Proposal storage p = _proposals[proposalId];
        return (
            p.token,
            p.proposalType,
            p.proposer,
            p.votingStart,
            p.votingEnd,
            p.voterCount,
            uint8(p.status)
        );
    }

    /// @inheritdoc IEncryptedGovernance
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return _hasVoted[proposalId][voter];
    }

    /// @notice Encrypted yes-weight handle for off-chain audit / regulator
    ///         review. Not decryptable by the public — owner re-grants ACL
    ///         to specific viewers via the standard CoFHE pattern.
    function encryptedYesWeight(uint256 proposalId) external view returns (euint128) {
        return _proposals[proposalId].encTotalYesWeight;
    }

    /// @notice Encrypted total-supply snapshot at proposal creation.
    function encryptedSupplySnapshot(uint256 proposalId) external view returns (euint128) {
        return _proposals[proposalId].encTotalSupplySnapshot;
    }

    /// @notice Encrypted tally result handle (1 if passed, 0 if defeated)
    ///         after `requestTally` has been called.
    function encryptedTallyResult(uint256 proposalId) external view returns (euint128) {
        return _proposals[proposalId].encTallyResult;
    }

    // ── Admin ────────────────────────────────────────────────────────

    /// @inheritdoc IEncryptedGovernance
    function setVotingPeriod(uint256 newPeriodSeconds) external onlyOwner {
        if (newPeriodSeconds == 0) revert InvalidVotingPeriod();
        votingPeriodSeconds = newPeriodSeconds;
        emit VotingPeriodUpdated(newPeriodSeconds);
    }

    /// @inheritdoc IEncryptedGovernance
    function setQuorumBps(uint256 newQuorumBps) external onlyOwner {
        if (newQuorumBps == 0 || newQuorumBps > 10000) revert InvalidQuorum();
        quorumBps = newQuorumBps;
        emit QuorumBpsUpdated(newQuorumBps);
    }

    /// @inheritdoc IEncryptedGovernance
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── EIP-165 ──────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override
        returns (bool)
    {
        return interfaceId == type(IEncryptedGovernance).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
