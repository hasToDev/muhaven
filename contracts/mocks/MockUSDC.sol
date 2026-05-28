// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Minimal 6-decimal ERC-20 used in tests as the raw USDC reserve
///         token for `MuHavenStable`'s direct mhUSDC→USDC exit (Wave 5 W3).
///         Public `mint` for fixture seeding. NOT for production.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
