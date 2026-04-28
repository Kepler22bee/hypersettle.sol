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
import {
  packDepositIntent,
  packInvoiceIntent,
  packSettlementOrder,
  type DepositIntent,
  type InvoiceIntent,
  type SettlementOrder,
  evmSettlementDigest,
  buildSettlementBundle,
  type IkaSignerLike,
  DEPOSIT_INTENT_PACKED_LEN,
  INVOICE_INTENT_PACKED_LEN,
  SETTLEMENT_ORDER_PACKED_LEN,
} from "../src/index.js";
import { recoverAddress } from "viem";

function fill32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  Buffer.from(label).copy(Buffer.from(out.buffer));
  return out;
}

function paddedAddr(addr: `0x${string}`): Uint8Array {
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

  // ── 0. Spoke-side: build the encrypted-amount intents that would go
  //      through Wormhole. These exercise the SDK packers; the bytes are
  //      what `wormhole.publishMessage` would carry. ──────────────────
  const deposit: DepositIntent = {
    version: 1,
    sourceChain: 10004,
    sourceDomain: 7,
    ticker: fill32("USDC"),
    assetHash: fill32("ETH:USDC"),
    epoch: 5n,
    amountCt: fill32("ct-deposit-A"),
    intentId: fill32("deposit-A"),
  };
  const invoice: InvoiceIntent = {
    version: 1,
    sourceChain: 10003,
    sourceDomain: 9,
    ticker: fill32("USDC"),
    epoch: 5n,
    amountCt: fill32("ct-invoice-1"),
    recipientChain: 10004,
    recipient: paddedAddr(recipientAddr),
    intentId: fill32("invoice-1"),
  };
  const dPacked = packDepositIntent(deposit);
  const iPacked = packInvoiceIntent(invoice);
  console.log(`[spoke] deposit payload: ${dPacked.length} bytes (expected ${DEPOSIT_INTENT_PACKED_LEN})`);
  console.log(`[spoke] invoice payload: ${iPacked.length} bytes (expected ${INVOICE_INTENT_PACKED_LEN})`);
  if (dPacked.length !== DEPOSIT_INTENT_PACKED_LEN) throw new Error("deposit length mismatch");
  if (iPacked.length !== INVOICE_INTENT_PACKED_LEN) throw new Error("invoice length mismatch");

  const ikaSigner: IkaSignerLike = {
    async signEvmDigest(digest) {
      const sig = await ikaAccount.sign({ hash: ("0x" + Buffer.from(digest).toString("hex")) as `0x${string}` });
      return Buffer.from(sig.slice(2), "hex");
    },
    async signSolanaMessage() {
      throw new Error("ed25519 path not exercised in this demo");
    },
  };

  // ── 1. Hub produces a SettlementOrder (hand-built; in real life this
  //      is the result of receive_invoice + match_slot_invoice +
  //      finalize_settlement + reveal_settlement). ──────────────────
  const order: SettlementOrder = {
    version: 1,
    sourceChain: 1, // Solana hub
    destChain: 10004, // Base Sepolia
    destDomain: 7,
    ticker: fill32("USDC"),
    assetHash: fill32("ETH:USDC"),
    amount: 1_000_000n, // 1 USDC at 6 decimals
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
  const orderPacked = packSettlementOrder(bundle.order);
  console.log(
    `[relayer] packed order: ${orderPacked.length} bytes (expected ${SETTLEMENT_ORDER_PACKED_LEN})`,
  );
  if (orderPacked.length !== SETTLEMENT_ORDER_PACKED_LEN) {
    throw new Error("settlement length mismatch");
  }

  // ── 4. Destination spoke verifies. We replay the EVM ECDSA recover
  //      path locally to prove the signature would pass on-chain. ───
  const recovered = await recoverAddress({
    hash: ("0x" + Buffer.from(digest).toString("hex")) as `0x${string}`,
    signature: ("0x" + Buffer.from(bundle.signature).toString("hex")) as `0x${string}`,
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
