// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ITrustedIssuersRegistry} from "./interfaces/ITrustedIssuersRegistry.sol";

/// @title TrustedIssuersRegistry
/// @notice Minimal ERC-3643 trusted-issuer registry consumed by
///         `MuHavenIdentityRegistry.isVerified` in production mode.
///         Deployed behind an OZ Transparent Proxy.
///
/// @dev Wave 3.5 ships this alongside the identity registry (ADR-011).
///      Each trusted issuer is bound to the set of topics it may attest.
///      The per-topic reverse index (`_issuersByTopic`) lets the identity
///      registry enumerate allowed issuers for a specific claim topic if
///      needed. Updates use swap-and-pop for O(1) writes.
contract TrustedIssuersRegistry is Initializable, ITrustedIssuersRegistry {

    // ── Storage ──────────────────────────────────────────────────────────

    address public owner;

    address[] private _issuers;
    /// @dev 1-based index into `_issuers` for swap-and-pop removal.
    mapping(address issuer => uint256 oneBasedIndex) private _issuerIndex;
    mapping(address issuer => uint256[] topics) private _issuerTopics;
    /// @dev Fast path for `hasClaimTopic(issuer, topic)`.
    mapping(address issuer => mapping(uint256 topic => bool)) private _issuerHasTopic;

    /// @dev Per-topic reverse index. Stores issuers authorised for a topic,
    ///      1-based index for swap-and-pop.
    mapping(uint256 topic => address[]) private _issuersByTopic;
    mapping(uint256 topic => mapping(address issuer => uint256 oneBasedIndex)) private _issuerByTopicIndex;

    uint256[45] private __gap;

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ── Initializer ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function addTrustedIssuer(address issuer, uint256[] calldata topics) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        if (topics.length == 0) revert EmptyTopicList();
        if (_issuerIndex[issuer] != 0) revert IssuerAlreadyTrusted();

        _issuers.push(issuer);
        _issuerIndex[issuer] = _issuers.length;

        _setIssuerTopics(issuer, topics);

        emit TrustedIssuerAdded(issuer, topics);
    }

    function removeTrustedIssuer(address issuer) external onlyOwner {
        uint256 oneBased = _issuerIndex[issuer];
        if (oneBased == 0) revert IssuerNotTrusted();

        // Drop the issuer from every per-topic list it belongs to, and the
        // fast-path flags.
        _clearIssuerTopics(issuer);

        // Swap-and-pop from `_issuers`.
        uint256 lastIndex = _issuers.length - 1;
        uint256 removeIndex = oneBased - 1;
        if (removeIndex != lastIndex) {
            address lastIssuer = _issuers[lastIndex];
            _issuers[removeIndex] = lastIssuer;
            _issuerIndex[lastIssuer] = oneBased;
        }
        _issuers.pop();
        delete _issuerIndex[issuer];

        emit TrustedIssuerRemoved(issuer);
    }

    function updateIssuerTopics(address issuer, uint256[] calldata topics) external onlyOwner {
        if (_issuerIndex[issuer] == 0) revert IssuerNotTrusted();
        if (topics.length == 0) revert EmptyTopicList();

        _clearIssuerTopics(issuer);
        _setIssuerTopics(issuer, topics);

        emit IssuerTopicsUpdated(issuer, topics);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    /// @dev Assumes `issuer` has no topics currently set. Writes `topics`
    ///      to the issuer's topic list + fast-path flags + per-topic reverse
    ///      index. Deduplicates input topics defensively.
    function _setIssuerTopics(address issuer, uint256[] calldata topics) internal {
        for (uint256 i = 0; i < topics.length; i++) {
            uint256 topic = topics[i];
            if (_issuerHasTopic[issuer][topic]) continue; // skip duplicate in input

            _issuerHasTopic[issuer][topic] = true;
            _issuerTopics[issuer].push(topic);

            _issuersByTopic[topic].push(issuer);
            _issuerByTopicIndex[topic][issuer] = _issuersByTopic[topic].length;
        }
    }

    /// @dev Clears the issuer's topic set (fast-path flags, topic list, and
    ///      per-topic reverse index). Does not touch the outer `_issuers`
    ///      array or `_issuerIndex`.
    function _clearIssuerTopics(address issuer) internal {
        uint256[] storage issuerTopics = _issuerTopics[issuer];
        for (uint256 i = 0; i < issuerTopics.length; i++) {
            uint256 topic = issuerTopics[i];
            _issuerHasTopic[issuer][topic] = false;

            // Swap-and-pop from the per-topic reverse index.
            uint256 oneBased = _issuerByTopicIndex[topic][issuer];
            if (oneBased != 0) {
                address[] storage list = _issuersByTopic[topic];
                uint256 lastIndex = list.length - 1;
                uint256 removeIndex = oneBased - 1;
                if (removeIndex != lastIndex) {
                    address lastIssuer = list[lastIndex];
                    list[removeIndex] = lastIssuer;
                    _issuerByTopicIndex[topic][lastIssuer] = oneBased;
                }
                list.pop();
                delete _issuerByTopicIndex[topic][issuer];
            }
        }
        delete _issuerTopics[issuer];
    }

    // ── Views ────────────────────────────────────────────────────────────

    function isTrustedIssuer(address issuer) external view returns (bool) {
        return _issuerIndex[issuer] != 0;
    }

    function hasClaimTopic(address issuer, uint256 topic) external view returns (bool) {
        return _issuerHasTopic[issuer][topic];
    }

    function getIssuerTopics(address issuer) external view returns (uint256[] memory) {
        return _issuerTopics[issuer];
    }

    function getTrustedIssuersForClaimTopic(uint256 topic) external view returns (address[] memory) {
        return _issuersByTopic[topic];
    }
}
