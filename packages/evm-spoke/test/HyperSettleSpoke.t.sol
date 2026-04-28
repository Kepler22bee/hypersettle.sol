// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {HyperSettleSpoke} from "../src/HyperSettleSpoke.sol";
import {Messages} from "../src/libs/Messages.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {
        _mint(msg.sender, 10_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MockWormhole is IWormhole {
    uint64 public nextSequence;
    bytes public lastPayload;
    uint32 public lastNonce;
    uint8 public lastConsistency;
    uint256 public feeOverride;

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistency)
        external
        payable
        returns (uint64 sequence)
    {
        require(msg.value >= feeOverride, "fee");
        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistency;
        sequence = ++nextSequence;
    }

    function messageFee() external view returns (uint256) { return feeOverride; }
    function setFee(uint256 f) external { feeOverride = f; }
}

/// Test harness overrides the Wormhole chain-id mapping so tests don't
/// depend on `vm.chainId(...)` plumbing into the production mapping.
contract TestSpoke is HyperSettleSpoke {
    uint16 private _whChain;
    constructor(
        address owner_,
        uint16 hubChain_,
        uint32 selfDomain_,
        address wormhole_,
        address ikaDWallet_,
        uint16 whChain
    ) HyperSettleSpoke(owner_, hubChain_, selfDomain_, wormhole_, ikaDWallet_) {
        _whChain = whChain;
    }
    function _thisWormholeChain() internal view override returns (uint16) { return _whChain; }
}

contract HyperSettleSpokeTest is Test {
    TestSpoke spoke;
    MockERC20 token;
    MockWormhole wormhole;

    address admin = address(0xA11CE);
    address user = address(0xBEEF);
    address recipientAddr = address(0xC0DE);

    uint16 constant THIS_WH_CHAIN = 10004; // Base Sepolia
    uint16 constant HUB_WH_CHAIN = 1;      // Solana
    uint32 constant SELF_DOMAIN = 7;

    bytes32 constant TICKER = keccak256("USDC");
    bytes32 constant ASSET = keccak256(abi.encodePacked(uint256(84532), address(0xDEADBEEF)));

    uint256 ikaKey; // private key for the "Ika dWallet" in tests
    address ikaAddr;

    function setUp() public {
        wormhole = new MockWormhole();
        token = new MockERC20();

        ikaKey = 0xDEADBEEF;
        ikaAddr = vm.addr(ikaKey);

        vm.prank(admin);
        spoke = new TestSpoke(admin, HUB_WH_CHAIN, SELF_DOMAIN, address(wormhole), ikaAddr, THIS_WH_CHAIN);

        vm.prank(admin);
        spoke.bindTicker(TICKER, address(token));

        token.mint(user, 10_000_000 ether);
    }

    // ── Deposit ────────────────────────────────────────────────────────

    function test_deposit_custodiesTokensAndEmitsIntent() public {
        uint256 amount = 1_000_000 ether;
        bytes32 ctHandle = keccak256("some-ciphertext-pubkey");

        vm.prank(user);
        token.approve(address(spoke), amount);

        vm.prank(user);
        (bytes32 intentId, uint64 sequence) = spoke.deposit(TICKER, ASSET, amount, ctHandle, 42);

        assertEq(token.balanceOf(address(spoke)), amount);
        assertEq(token.balanceOf(user), 10_000_000 ether - amount);
        assertEq(sequence, 1);
        assertEq(intentId, keccak256(abi.encodePacked(address(spoke), uint64(1))));

        // Wormhole recorded the packed payload; verify length + key fields.
        bytes memory payload = wormhole.lastPayload();
        assertEq(payload.length, 143, "deposit packed length");
        assertEq(uint8(payload[0]), 1, "version");
        // ticker lives at offset 7 (1 + 2 + 4)
        bytes32 gotTicker;
        assembly { gotTicker := mload(add(payload, 39)) } // 32 (len prefix) + 7
        assertEq(gotTicker, TICKER);
        // intentId lives at offset 143 - 32 = 111
        bytes32 gotIntent;
        assembly { gotIntent := mload(add(payload, 143)) } // 32 + 111
        assertEq(gotIntent, intentId);
    }

    function test_deposit_revertsOnUnboundTicker() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(HyperSettleSpoke.UnboundTicker.selector, keccak256("UNKNOWN"))
        );
        spoke.deposit(keccak256("UNKNOWN"), ASSET, 1, bytes32(uint256(1)), 1);
    }

    // ── Invoice ────────────────────────────────────────────────────────

    function test_invoice_emitsIntentWithoutTokenMovement() public {
        uint256 before = token.balanceOf(user);

        vm.prank(user);
        (, uint64 sequence) = spoke.invoice(
            TICKER,
            keccak256("inv-ct"),
            77,
            HUB_WH_CHAIN,
            bytes32(uint256(uint160(recipientAddr)))
        );

        assertEq(sequence, 1);
        assertEq(token.balanceOf(user), before, "no token movement");

        bytes memory payload = wormhole.lastPayload();
        assertEq(payload.length, 145, "invoice packed length");
        assertEq(uint8(payload[0]), 1, "version");
    }

    // ── Settlement execution ───────────────────────────────────────────

    function _fundSpokeLiquidity(uint256 amount) internal {
        token.mint(address(spoke), amount);
    }

    function _signOrder(Messages.SettlementOrder memory order) internal view returns (bytes memory) {
        bytes32 digest = Messages.settlementDigest(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ikaKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _defaultOrder() internal view returns (Messages.SettlementOrder memory order) {
        order = Messages.SettlementOrder({
            version: 1,
            sourceChain: HUB_WH_CHAIN,
            destChain: THIS_WH_CHAIN,
            destDomain: SELF_DOMAIN,
            ticker: TICKER,
            assetHash: ASSET,
            amount: 500_000_000, // u64, 6-decimal scale
            recipient: bytes32(uint256(uint160(recipientAddr))),
            intentId: keccak256("intent-x"),
            nonce: 1
        });
    }

    function test_executeSettlement_happyPath() public {
        _fundSpokeLiquidity(1_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        bytes memory sig = _signOrder(order);

        uint256 recipientBefore = token.balanceOf(recipientAddr);
        spoke.executeSettlement(order, sig);

        assertEq(token.balanceOf(recipientAddr), recipientBefore + order.amount);
        assertTrue(spoke.consumedNonces(order.nonce));
    }

    function test_executeSettlement_rejectsBadSignature() public {
        _fundSpokeLiquidity(1_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        uint256 wrongKey = 0xCAFEBABE;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, Messages.settlementDigest(order));
        bytes memory wrongSig = abi.encodePacked(r, s, v);

        vm.expectRevert(HyperSettleSpoke.InvalidSignature.selector);
        spoke.executeSettlement(order, wrongSig);
        assertFalse(spoke.consumedNonces(order.nonce));
    }

    function test_executeSettlement_rejectsReplay() public {
        _fundSpokeLiquidity(2_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        bytes memory sig = _signOrder(order);

        spoke.executeSettlement(order, sig);

        vm.expectRevert(
            abi.encodeWithSelector(HyperSettleSpoke.NonceAlreadyConsumed.selector, order.nonce)
        );
        spoke.executeSettlement(order, sig);
    }

    function test_executeSettlement_rejectsWrongDestChain() public {
        _fundSpokeLiquidity(1_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        order.destChain = 999; // not our chain
        bytes memory sig = _signOrder(order);

        vm.expectRevert(
            abi.encodeWithSelector(
                HyperSettleSpoke.DestinationMismatch.selector,
                THIS_WH_CHAIN,
                uint16(999)
            )
        );
        spoke.executeSettlement(order, sig);
    }

    function test_executeSettlement_rejectsWrongDomain() public {
        _fundSpokeLiquidity(1_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        order.destDomain = SELF_DOMAIN + 1;
        bytes memory sig = _signOrder(order);

        vm.expectRevert(
            abi.encodeWithSelector(
                HyperSettleSpoke.DomainMismatch.selector,
                SELF_DOMAIN,
                SELF_DOMAIN + 1
            )
        );
        spoke.executeSettlement(order, sig);
    }

    function test_executeSettlement_rejectsVersionMismatch() public {
        _fundSpokeLiquidity(1_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        order.version = 2;
        bytes memory sig = _signOrder(order);

        vm.expectRevert(abi.encodeWithSelector(HyperSettleSpoke.VersionUnsupported.selector, uint8(2)));
        spoke.executeSettlement(order, sig);
    }

    // ── Admin ──────────────────────────────────────────────────────────

    function test_setIkaDWallet_rotatesAuthorizedSigner() public {
        uint256 newKey = 0x1234;
        address newAddr = vm.addr(newKey);

        vm.prank(admin);
        spoke.setIkaDWallet(newAddr);
        assertEq(spoke.ikaDWallet(), newAddr);

        // Old key's signature no longer validates.
        _fundSpokeLiquidity(1_000 ether);
        Messages.SettlementOrder memory order = _defaultOrder();
        bytes memory oldSig = _signOrder(order);
        vm.expectRevert(HyperSettleSpoke.InvalidSignature.selector);
        spoke.executeSettlement(order, oldSig);

        // New key's signature validates.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newKey, Messages.settlementDigest(order));
        spoke.executeSettlement(order, abi.encodePacked(r, s, v));
        assertTrue(spoke.consumedNonces(order.nonce));
    }

    function test_bindTicker_onlyOwner() public {
        vm.prank(user);
        vm.expectRevert();
        spoke.bindTicker(keccak256("EURC"), address(token));
    }
}
