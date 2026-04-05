// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestTreasury
/// @notice Minimal ERC-20 used to test MuHavenVault wrap/unwrap flows.
///         Not for production use.
contract TestTreasury is ERC20 {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply
    ) ERC20(name_, symbol_) {
        _mint(msg.sender, initialSupply);
    }

    /// @notice Mint tokens to any address. Public for test convenience.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
