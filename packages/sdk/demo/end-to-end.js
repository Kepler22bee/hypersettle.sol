// End-to-end demo: walk a settlement bundle from the hub's perspective
// through Ika signing (mocked locally) to the destination EVM spoke's
// verification path. No live deployments — we exercise:
//   1. Hub builds + reveals the SettlementOrder.
//   2. Hub event would emit (we synthesize it).
//   3. Relayer fetches Ika signature (mocked with a local secp256k1 key).
//   4. Destination spoke verifies the signature against the registered
//      Ika dWallet address.
//
// Step 4 is checked via a local viem signer + ecrecover. Same code path
// the on-chain `executeSettlement` uses.
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { packSettlementOrder, evmSettlementDigest, buildSettlementBundle, } from "../src/index.js";
import { recoverAddress } from "viem";
function fill32(label) {
    const out = new Uint8Array(32);
    Buffer.from(label).copy(Buffer.from(out.buffer));
    return out;
}
function paddedAddr(addr) {
    const out = new Uint8Array(32);
    out.set(Buffer.from(addr.slice(2), "hex"), 12);
    return out;
}
async function main() {
    // ── Setup ─────────────────────────────────────────────────────────
    const ikaKey = generatePrivateKey();
    const ikaAccount = privateKeyToAccount(ikaKey);
    console.log("[setup] mock Ika dWallet address:", ikaAccount.address);
    const recipientKey = generatePrivateKey();
    const recipientAddr = privateKeyToAccount(recipientKey).address;
    console.log("[setup] settlement recipient:", recipientAddr);
    const ikaSigner = {
        async signEvmDigest(digest) {
            const sig = await ikaAccount.sign({ hash: ("0x" + Buffer.from(digest).toString("hex")) });
            return Buffer.from(sig.slice(2), "hex");
        },
        async signSolanaMessage() {
            throw new Error("ed25519 path not exercised in this demo");
        },
    };
    // ── 1. Hub produces a SettlementOrder (hand-built; in real life this
    //      is the result of receive_invoice + match_slot_invoice +
    //      finalize_settlement + reveal_settlement). ──────────────────
    const order = {
        version: 1,
        sourceChain: 1, // Solana hub
        destChain: 10004, // Base Sepolia
        destDomain: 7,
        ticker: fill32("USDC"),
        assetHash: fill32("ETH:USDC"),
        amount: 1000000n, // 1 USDC at 6 decimals
        recipient: paddedAddr(recipientAddr),
        intentId: fill32("invoice-1"),
        nonce: 1n,
    };
    console.log("[hub] reveals order: amount=", order.amount.toString(), "ticker=USDC");
    // ── 2. Hub emits SettlementDispatched (with message_digest the
    //      destination spoke recomputes). ───────────────────────────
    const digest = evmSettlementDigest(order);
    console.log("[hub] settlement digest:", "0x" + Buffer.from(digest).toString("hex"));
    // ── 3. Relayer asks Ika for the signature (here, mocked locally). ──
    const bundle = await buildSettlementBundle(ikaSigner, order);
    console.log("[relayer] got Ika signature:", "0x" + Buffer.from(bundle.signature).toString("hex"));
    console.log("[relayer] packed order bytes:", "0x" + packSettlementOrder(bundle.order).toString("hex"));
    // ── 4. Destination spoke verifies. We replay the EVM ECDSA recover
    //      path locally to prove the signature would pass on-chain. ───
    const recovered = await recoverAddress({
        hash: ("0x" + Buffer.from(digest).toString("hex")),
        signature: ("0x" + Buffer.from(bundle.signature).toString("hex")),
    });
    if (recovered.toLowerCase() !== ikaAccount.address.toLowerCase()) {
        throw new Error("signature verification failed!");
    }
    console.log("[evm-spoke] recovered signer matches registered Ika dWallet ✓");
    console.log("\nDemo OK — settlement bundle is ready to submit to spoke.executeSettlement()");
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=end-to-end.js.map