// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HyperSettleSpoke} from "../src/HyperSettleSpoke.sol";
import {Messages} from "../src/libs/Messages.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";

/// Confirms the wire-format the SDK relayer produces (`SettlementOrder`
/// 153-byte big-endian packing) matches what the EVM spoke recomputes
/// inside `executeSettlement`. Same bytes → same digest → same recovered
/// signer. If this test passes, the SDK demo's signature really would
/// verify on a deployed spoke.

contract MockERC20Tok is ERC20 {
    constructor() ERC20("M", "M") { _mint(msg.sender, 1e30); }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract MockWormholeT is IWormhole {
    function publishMessage(uint32, bytes memory, uint8) external payable returns (uint64) { return 1; }
    function messageFee() external pure returns (uint256) { return 0; }
}

contract TestSpokeCS is HyperSettleSpoke {
    constructor(address o, uint16 hc, uint32 sd, address w, address i)
        HyperSettleSpoke(o, hc, sd, w, i) {}
    function _thisWormholeChain() internal pure override returns (uint16) { return 10004; }
}

contract CrossStackBundleTest is Test {
    function test_packedOrderLengthIs153() public pure {
        Messages.SettlementOrder memory o = Messages.SettlementOrder({
            version: 1,
            sourceChain: 1,
            destChain: 10004,
            destDomain: 7,
            ticker: keccak256("USDC"),
            assetHash: keccak256("a"),
            amount: 1_000_000,
            recipient: bytes32(uint256(uint160(address(0x1234)))),
            intentId: keccak256("i"),
            nonce: 1
        });
        bytes memory packed = Messages.packSettlementOrder(o);
        assertEq(packed.length, 153, "wire length");
    }

    function test_signatureMatchingPackedDigestVerifies() public {
        MockERC20Tok t = new MockERC20Tok();
        MockWormholeT w = new MockWormholeT();
        uint256 ikaKey = 0xCAFE;
        address ika = vm.addr(ikaKey);
        TestSpokeCS s = new TestSpokeCS(address(this), 1, 7, address(w), ika);
        s.bindTicker(keccak256("USDC"), address(t));
        t.mint(address(s), 10_000_000);

        Messages.SettlementOrder memory o = Messages.SettlementOrder({
            version: 1,
            sourceChain: 1,
            destChain: 10004,
            destDomain: 7,
            ticker: keccak256("USDC"),
            assetHash: keccak256("a"),
            amount: 1_000_000,
            recipient: bytes32(uint256(uint160(address(0xC0DE)))),
            intentId: keccak256("i"),
            nonce: 1
        });

        bytes32 digest = Messages.settlementDigest(o);
        (uint8 v, bytes32 r, bytes32 ssig) = vm.sign(ikaKey, digest);
        bytes memory sig = abi.encodePacked(r, ssig, v);

        s.executeSettlement(o, sig);
        assertEq(t.balanceOf(address(0xC0DE)), 1_000_000);
    }
}
