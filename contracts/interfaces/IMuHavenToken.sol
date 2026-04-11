// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {euint128, InEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IMuHavenToken {
    function mint(address to, InEuint128 memory encryptedAmount) external;
    function mintFromVault(address to, uint256 amount) external;
    function burnFromVault(address from, uint256 amount) external;
    function encryptedBalanceOf(address account) external view returns (euint128);
    function encryptedTotalSupply() external view returns (euint128);
    function setTotalSupplyPublic() external;
    function totalSupplyPublic() external view returns (bool);
    function pause() external;
    function unpause() external;
}
