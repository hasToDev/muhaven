// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IReineiraEscrow {
    function create(address beneficiary, euint128 amount, address gate) external returns (uint256 escrowId);
    function getEscrow(uint256 id) external view returns (address beneficiary, euint128 amount, address gate);
}
