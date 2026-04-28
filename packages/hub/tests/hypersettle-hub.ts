import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { HypersettleHub } from "../target/types/hypersettle_hub";
import { expect } from "chai";

// Phase 5 integration tests. Instructions now take VAA-style inputs
// (emitter_chain + emitter_address + packed payload) instead of a typed
// DepositIntent/InvoiceIntent struct. Admin stands in for a Wormhole
// relayer; real Wormhole CPI replacement lands in a later phase.

const CONFIG_SEED = Buffer.from("config");
const DEPOSIT_BUCKET_SEED = Buffer.from("deposits");
const INVOICE_SEED = Buffer.from("invoice");
const SETTLEMENT_SEED = Buffer.from("settlement");
const REGISTERED_SPOKE_SEED = Buffer.from("spoke");

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2); b.writeUInt16LE(n); return b;
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4); b.writeUInt32LE(n); return b;
}
function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b;
}
function bytes32(label: string): number[] {
  const h = Buffer.alloc(32); Buffer.from(label).copy(h); return Array.from(h);
}
function mockCt(label: string): number[] {
  return Array.from(Keypair.generate().publicKey.toBytes());
}

// Packed big-endian encoders matching the hub's parse_*_packed helpers and
// the EVM spoke's Messages.sol pack functions.
function packDepositIntent(intent: {
  version: number;
  sourceChain: number;
  sourceDomain: number;
  ticker: number[];
  assetHash: number[];
  epoch: bigint;
  amountCt: number[];
  intentId: number[];
}): Buffer {
  const buf = Buffer.alloc(143);
  let off = 0;
  buf.writeUInt8(intent.version, off); off += 1;
  buf.writeUInt16BE(intent.sourceChain, off); off += 2;
  buf.writeUInt32BE(intent.sourceDomain, off); off += 4;
  Buffer.from(intent.ticker).copy(buf, off); off += 32;
  Buffer.from(intent.assetHash).copy(buf, off); off += 32;
  buf.writeBigUInt64BE(intent.epoch, off); off += 8;
  Buffer.from(intent.amountCt).copy(buf, off); off += 32;
  Buffer.from(intent.intentId).copy(buf, off); off += 32;
  return buf;
}

function packInvoiceIntent(intent: {
  version: number;
  sourceChain: number;
  sourceDomain: number;
  ticker: number[];
  epoch: bigint;
  amountCt: number[];
  recipientChain: number;
  recipient: number[];
  intentId: number[];
}): Buffer {
  const buf = Buffer.alloc(145);
  let off = 0;
  buf.writeUInt8(intent.version, off); off += 1;
  buf.writeUInt16BE(intent.sourceChain, off); off += 2;
  buf.writeUInt32BE(intent.sourceDomain, off); off += 4;
  Buffer.from(intent.ticker).copy(buf, off); off += 32;
  buf.writeBigUInt64BE(intent.epoch, off); off += 8;
  Buffer.from(intent.amountCt).copy(buf, off); off += 32;
  buf.writeUInt16BE(intent.recipientChain, off); off += 2;
  Buffer.from(intent.recipient).copy(buf, off); off += 32;
  Buffer.from(intent.intentId).copy(buf, off); off += 32;
  return buf;
}

describe("hypersettle-hub — Phase 5 VAA consumption", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.hypersettleHub as Program<HypersettleHub>;

  const TICKER = bytes32("USDC");
  const ASSET = bytes32("ETH:USDC");
  const EPOCH = BigInt(5);
  const SOURCE_CHAIN = 10002;
  const SOURCE_DOMAIN = 1;
  const SOURCE_EMITTER = bytes32("0x..evm-spoke-A");
  const DEST_CHAIN = 10004;

  let configPda: PublicKey;
  let spokePda: PublicKey;

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId);
    [spokePda] = PublicKey.findProgramAddressSync(
      [REGISTERED_SPOKE_SEED, u16le(SOURCE_CHAIN), Buffer.from(SOURCE_EMITTER)],
      program.programId,
    );
  });

  it("initializes the hub config", async () => {
    await program.methods
      .initialize(1000, 500_000)
      .accounts({
        admin: provider.wallet.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("registers a spoke emitter", async () => {
    await program.methods
      .registerSpoke(SOURCE_CHAIN, SOURCE_EMITTER, SOURCE_DOMAIN)
      .accounts({
        admin: provider.wallet.publicKey,
        config: configPda,
        spoke: spokePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const s = await program.account.registeredSpoke.fetch(spokePda);
    expect(s.chain).to.equal(SOURCE_CHAIN);
    expect(s.domain).to.equal(SOURCE_DOMAIN);
  });

  it("receives a deposit VAA and writes ct ref to the bucket", async () => {
    const amountCt = mockCt("deposit-0-ct");
    const intentId = bytes32("deposit-0");
    const payload = packDepositIntent({
      version: 1,
      sourceChain: SOURCE_CHAIN,
      sourceDomain: SOURCE_DOMAIN,
      ticker: TICKER,
      assetHash: ASSET,
      epoch: EPOCH,
      amountCt,
      intentId,
    });

    const [bucket] = PublicKey.findProgramAddressSync(
      [DEPOSIT_BUCKET_SEED, Buffer.from(TICKER), u64le(EPOCH), u32le(SOURCE_DOMAIN)],
      program.programId,
    );

    await program.methods
      .receiveDeposit(
        SOURCE_CHAIN,
        SOURCE_EMITTER,
        TICKER,
        new BN(EPOCH.toString()),
        SOURCE_DOMAIN,
        payload,
      )
      .accounts({
        admin: provider.wallet.publicKey,
        config: configPda,
        spoke: spokePda,
        bucket,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const b = await program.account.depositBucket.fetch(bucket);
    expect(b.slotCount).to.equal(1);
    expect(Array.from(b.slots[0].amountCt)).to.deep.equal(amountCt);
    expect(Array.from(b.slots[0].intentId)).to.deep.equal(intentId);
  });

  it("rejects a deposit payload with mismatching ticker seed", async () => {
    const payload = packDepositIntent({
      version: 1,
      sourceChain: SOURCE_CHAIN,
      sourceDomain: SOURCE_DOMAIN,
      ticker: TICKER,
      assetHash: ASSET,
      epoch: EPOCH,
      amountCt: mockCt("d1"),
      intentId: bytes32("deposit-1"),
    });
    const WRONG_TICKER = bytes32("USDT");
    const [bucket] = PublicKey.findProgramAddressSync(
      [DEPOSIT_BUCKET_SEED, Buffer.from(WRONG_TICKER), u64le(EPOCH), u32le(SOURCE_DOMAIN)],
      program.programId,
    );
    try {
      await program.methods
        .receiveDeposit(
          SOURCE_CHAIN, SOURCE_EMITTER, WRONG_TICKER, new BN(EPOCH.toString()), SOURCE_DOMAIN, payload,
        )
        .accounts({
          admin: provider.wallet.publicKey,
          config: configPda,
          spoke: spokePda,
          bucket,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected BadVersion (ticker-mismatch check)");
    } catch (e: any) {
      expect(e.toString()).to.include("BadVersion");
    }
  });

  it("rejects a deposit from an unregistered emitter", async () => {
    const FAKE_EMITTER = bytes32("0x..unknown");
    const payload = packDepositIntent({
      version: 1,
      sourceChain: SOURCE_CHAIN,
      sourceDomain: SOURCE_DOMAIN,
      ticker: TICKER,
      assetHash: ASSET,
      epoch: EPOCH,
      amountCt: mockCt("d2"),
      intentId: bytes32("deposit-2"),
    });
    const [fakeSpoke] = PublicKey.findProgramAddressSync(
      [REGISTERED_SPOKE_SEED, u16le(SOURCE_CHAIN), Buffer.from(FAKE_EMITTER)],
      program.programId,
    );
    const [bucket] = PublicKey.findProgramAddressSync(
      [DEPOSIT_BUCKET_SEED, Buffer.from(TICKER), u64le(EPOCH), u32le(SOURCE_DOMAIN)],
      program.programId,
    );
    try {
      await program.methods
        .receiveDeposit(
          SOURCE_CHAIN, FAKE_EMITTER, TICKER, new BN(EPOCH.toString()), SOURCE_DOMAIN, payload,
        )
        .accounts({
          admin: provider.wallet.publicKey,
          config: configPda,
          spoke: fakeSpoke,
          bucket,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected AccountNotInitialized on unregistered spoke PDA");
    } catch (e: any) {
      expect(e.toString()).to.match(/AccountNotInitialized|0xbc4/);
    }
  });

  it("receives an invoice VAA and persists ct refs", async () => {
    const intentId = bytes32("invoice-1");
    const amountCt = mockCt("invoice-amount");
    const payload = packInvoiceIntent({
      version: 1,
      sourceChain: SOURCE_CHAIN,
      sourceDomain: SOURCE_DOMAIN,
      ticker: TICKER,
      epoch: EPOCH,
      amountCt,
      recipientChain: DEST_CHAIN,
      recipient: bytes32("recipient-A"),
      intentId,
    });
    const remainingCt = mockCt("invoice-remaining");

    const [invoicePda] = PublicKey.findProgramAddressSync(
      [INVOICE_SEED, Buffer.from(intentId)],
      program.programId,
    );

    await program.methods
      .receiveInvoice(SOURCE_CHAIN, SOURCE_EMITTER, intentId, payload, remainingCt)
      .accounts({
        admin: provider.wallet.publicKey,
        config: configPda,
        spoke: spokePda,
        invoice: invoicePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const inv = await program.account.invoice.fetch(invoicePda);
    expect(Array.from(inv.amountCt)).to.deep.equal(amountCt);
    expect(Array.from(inv.remainingCt)).to.deep.equal(remainingCt);
    expect(inv.settled).to.equal(false);
  });

  // dispatch_settlement now invokes the Ika `approve_message` CPI and
  // requires the full DWalletContext account set + dWallet/coordinator PDAs.
  // Exercising it on localnet would need the Ika program deployed and a
  // dWallet provisioned; we rely on the Anchor type generation to verify
  // the call shape compiles, and skip the runtime test until devnet.
  it.skip("dispatch_settlement invokes Ika approve_message");

  // Encrypt-CPI-dependent flows still require devnet Encrypt program.
  it.skip("match_slot_invoice invokes the match_slot_graph via Encrypt CPI");
  it.skip("finalize_settlement invokes settle_graph");
  it.skip("request_settlement_decryption + reveal_settlement cycle");
});
