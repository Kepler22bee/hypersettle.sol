// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HyperSettleSpoke} from "../src/HyperSettleSpoke.sol";

contract DeploySpoke is Script {
    uint16 internal constant HUB_CHAIN_SOLANA = 1;

    address internal constant BASE_SEPOLIA_WORMHOLE =
        0x79A1027a6A159502049F10906D333EC57E95F083;
    address internal constant BASE_SEPOLIA_USDC =
        0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    address internal constant ARBITRUM_SEPOLIA_WORMHOLE =
        0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35;
    address internal constant ARBITRUM_SEPOLIA_USDC =
        0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    function run() external returns (HyperSettleSpoke spoke) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("OWNER", deployer);
        address ikaDWallet = vm.envOr("IKA_DWALLET", deployer);

        (address wormhole, address usdc, uint32 selfDomain) = networkConfig();

        vm.startBroadcast(deployerKey);
        spoke = new HyperSettleSpoke(
            owner,
            HUB_CHAIN_SOLANA,
            selfDomain,
            wormhole,
            ikaDWallet
        );
        spoke.bindTicker(keccak256("USDC"), usdc);
        vm.stopBroadcast();

        console2.log("HyperSettleSpoke:", address(spoke));
        console2.log("Owner:", owner);
        console2.log("Ika dWallet:", ikaDWallet);
        console2.log("USDC:", usdc);
        console2.log("NEXT_PUBLIC_EVM_SPOKE_ADDRESS=%s", address(spoke));
    }

    function networkConfig()
        internal
        view
        returns (address wormhole, address usdc, uint32 selfDomain)
    {
        if (block.chainid == 84532) {
            return (BASE_SEPOLIA_WORMHOLE, BASE_SEPOLIA_USDC, 7);
        }
        if (block.chainid == 421614) {
            return (ARBITRUM_SEPOLIA_WORMHOLE, ARBITRUM_SEPOLIA_USDC, 9);
        }
        revert("unsupported chain");
    }
}
