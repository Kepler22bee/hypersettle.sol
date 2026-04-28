import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { expect } from "chai";
import { HypersettleSpoke } from "../target/types/hypersettle_spoke";

const CONFIG_SEED = Buffer.from("config");
const TICKER_SEED = Buffer.from("ticker");
const VAULT_SEED = Buffer.from("vault");
const SPOKE_AUTHORITY_SEED = Buffer.from("spoke_authority");
const NONCE_SEED = Buffer.from("nonce");

function bytes32(label: string): number[] {
  const h = Buffer.alloc(32);
  Buffer.from(label).copy(h);
  return Array.from(h);
}
function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("hypersettle-spoke — Phase 4", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.hypersettleSpoke as Program<HypersettleSpoke>;
  const payer = (provider.wallet as anchor.Wallet).payer as Keypair;

  const SELF_DOMAIN = 7;
  const HUB_CHAIN = 1;
  const SELF_CHAIN = 1;
  const TICKER = bytes32("USDC");
  const ASSET = bytes32("SOL:USDC");

  const ikaSecret = nacl.sign.keyPair();
  const ikaPubkey = new PublicKey(ikaSecret.publicKey);

  let mintAddr: PublicKey;
  let configPda: PublicKey;
  let tickerPda: PublicKey;
  let vaultPda: PublicKey;
  let spokeAuthorityPda: PublicKey;
  let userAta: PublicKey;
  const recipient = Keypair.generate();

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId);
    [tickerPda] = PublicKey.findProgramAddressSync(
      [TICKER_SEED, Buffer.from(TICKER)],
      program.programId,
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, Buffer.from(TICKER)],
      program.programId,
    );
    [spokeAuthorityPda] = PublicKey.findProgramAddressSync(
      [SPOKE_AUTHORITY_SEED],
      program.programId,
    );
  });

  it("initializes config", async () => {
    await program.methods
      .initialize(ikaPubkey, SELF_DOMAIN, HUB_CHAIN, SELF_CHAIN)
      .accounts({
        admin: payer.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.spokeConfig.fetch(configPda);
    expect(cfg.admin.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(cfg.ikaDwallet.toBase58()).to.equal(ikaPubkey.toBase58());
    expect(cfg.selfDomain).to.equal(SELF_DOMAIN);
  });

  it("binds a ticker and creates a vault", async () => {
    mintAddr = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );

    await program.methods
      .bindTicker(TICKER)
      .accounts({
        admin: payer.publicKey,
        config: configPda,
        mint: mintAddr,
        tickerBinding: tickerPda,
        spokeAuthority: spokeAuthorityPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const binding = await program.account.tickerBinding.fetch(tickerPda);
    expect(binding.mint.toBase58()).to.equal(mintAddr.toBase58());
  });

  it("deposits into the vault", async () => {
    const userAtaInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection, payer, mintAddr, payer.publicKey,
    );
    userAta = userAtaInfo.address;
    await mintTo(provider.connection, payer, mintAddr, userAta, payer, 1_000_000_000);

    await program.methods
      .deposit(TICKER, ASSET, new BN(250_000_000), bytes32("deposit-0-ct"), new BN(42))
      .accounts({
        user: payer.publicKey,
        config: configPda,
        tickerBinding: tickerPda,
        mint: mintAddr,
        vault: vaultPda,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vault = await getAccount(provider.connection, vaultPda);
    expect(vault.amount.toString()).to.equal("250000000");
  });

  it("creates an invoice intent without moving tokens", async () => {
    const before = (await getAccount(provider.connection, vaultPda)).amount;
    await program.methods
      .createInvoice(
        TICKER,
        bytes32("invoice-ct"),
        new BN(50),
        SELF_CHAIN,
        Array.from(recipient.publicKey.toBytes()),
      )
      .accounts({ user: payer.publicKey, config: configPda })
      .rpc();
    const after = (await getAccount(provider.connection, vaultPda)).amount;
    expect(after).to.equal(before);
  });

  async function buildSettlement(opts: {
    amount: bigint;
    nonce: bigint;
    destChain?: number;
    destDomain?: number;
    signWith?: Uint8Array;
    pubkeyForIx?: Uint8Array;
  }) {
    const recipientAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, payer, mintAddr, recipient.publicKey,
      )
    ).address;

    const order = {
      version: 1,
      sourceChain: HUB_CHAIN,
      destChain: opts.destChain ?? SELF_CHAIN,
      destDomain: opts.destDomain ?? SELF_DOMAIN,
      ticker: TICKER,
      assetHash: ASSET,
      amount: new BN(opts.amount.toString()),
      recipient: Array.from(recipient.publicKey.toBytes()),
      intentId: bytes32(`intent-${opts.nonce}`),
      nonce: new BN(opts.nonce.toString()),
    };
    // Hand-encode Borsh for the settlement order (153 bytes). Must match the
    // field order of `SettlementOrder` in the program's state/messages.rs.
    const msg = Buffer.alloc(1 + 2 + 2 + 4 + 32 + 32 + 8 + 32 + 32 + 8);
    let off = 0;
    msg.writeUInt8(order.version, off); off += 1;
    msg.writeUInt16LE(order.sourceChain, off); off += 2;
    msg.writeUInt16LE(order.destChain, off); off += 2;
    msg.writeUInt32LE(order.destDomain, off); off += 4;
    Buffer.from(order.ticker).copy(msg, off); off += 32;
    Buffer.from(order.assetHash).copy(msg, off); off += 32;
    msg.writeBigUInt64LE(BigInt(order.amount.toString()), off); off += 8;
    Buffer.from(order.recipient).copy(msg, off); off += 32;
    Buffer.from(order.intentId).copy(msg, off); off += 32;
    msg.writeBigUInt64LE(BigInt(order.nonce.toString()), off); off += 8;

    const signer = opts.signWith ?? ikaSecret.secretKey;
    const signature = nacl.sign.detached(msg, signer);

    const pubkeyForIx = opts.pubkeyForIx ?? ikaSecret.publicKey;
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: pubkeyForIx,
      message: msg,
      signature,
    });

    const [noncePda] = PublicKey.findProgramAddressSync(
      [NONCE_SEED, u64le(opts.nonce)],
      program.programId,
    );
    return { order, ed25519Ix, noncePda, recipientAta };
  }

  async function executeSettlementAccounts(
    order: any,
    noncePda: PublicKey,
    recipientAta: PublicKey,
  ) {
    return program.methods
      .executeSettlement(order)
      .accounts({
        payer: payer.publicKey,
        config: configPda,
        tickerBinding: tickerPda,
        mint: mintAddr,
        vault: vaultPda,
        recipientTokenAccount: recipientAta,
        spokeAuthority: spokeAuthorityPda,
        consumedNonce: noncePda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  it("executes a valid Ika-signed settlement", async () => {
    const { order, ed25519Ix, noncePda, recipientAta } = await buildSettlement({
      amount: 100_000_000n, nonce: 1n,
    });
    const executeIx = await executeSettlementAccounts(order, noncePda, recipientAta);
    const tx = new Transaction().add(ed25519Ix).add(executeIx);
    await provider.sendAndConfirm(tx, [payer]);

    const recipientAcct = await getAccount(provider.connection, recipientAta);
    expect(recipientAcct.amount.toString()).to.equal("100000000");
  });

  it("rejects replay of a consumed nonce", async () => {
    const { order, ed25519Ix, noncePda, recipientAta } = await buildSettlement({
      amount: 1n, nonce: 1n,
    });
    const executeIx = await executeSettlementAccounts(order, noncePda, recipientAta);
    const tx = new Transaction().add(ed25519Ix).add(executeIx);
    try {
      await provider.sendAndConfirm(tx, [payer]);
      expect.fail("expected replay to revert");
    } catch (e: any) {
      expect(e.toString()).to.match(/already in use|0x0/);
    }
  });

  it("rejects ed25519 precompile from wrong signer", async () => {
    const wrong = nacl.sign.keyPair();
    const { order, ed25519Ix, noncePda, recipientAta } = await buildSettlement({
      amount: 10_000_000n, nonce: 2n,
      signWith: wrong.secretKey,
      pubkeyForIx: wrong.publicKey,
    });
    const executeIx = await executeSettlementAccounts(order, noncePda, recipientAta);
    const tx = new Transaction().add(ed25519Ix).add(executeIx);
    try {
      await provider.sendAndConfirm(tx, [payer]);
      expect.fail("expected Ed25519IxMismatch");
    } catch (e: any) {
      expect(e.toString()).to.include("Ed25519IxMismatch");
    }
  });

  it("rejects wrong destination chain", async () => {
    const { order, ed25519Ix, noncePda, recipientAta } = await buildSettlement({
      amount: 5_000_000n, nonce: 3n, destChain: 999,
    });
    const executeIx = await executeSettlementAccounts(order, noncePda, recipientAta);
    const tx = new Transaction().add(ed25519Ix).add(executeIx);
    try {
      await provider.sendAndConfirm(tx, [payer]);
      expect.fail("expected DestinationMismatch");
    } catch (e: any) {
      expect(e.toString()).to.include("DestinationMismatch");
    }
  });
});
