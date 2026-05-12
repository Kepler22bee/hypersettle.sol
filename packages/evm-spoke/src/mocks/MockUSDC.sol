// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Demo-only mock of USDC. 6 decimals, openly mintable so the netting
/// orchestrator can fund test users and the spoke vault without a faucet.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
