// Solana-side bring-up for the netting demo.
//
// Boots a fresh solana-test-validator with the hypersettle_spoke program
// pre-loaded, creates a mock USDC SPL mint, initializes the spoke config
// against a freshly-generated ed25519 Ika dWallet, binds the ticker, and
// funds user B + the vault PDA with mUSDC liquidity.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import nacl from "tweetnacl";

const REPO_ROOT = join(__dirname, "../../../..");
const PROGRAM_KEYPAIR_PATH = join(
  REPO_ROOT,
  "packages/solana-spoke/target/deploy/hypersettle_spoke-keypair.json",
);
const PROGRAM_SO_PATH = join(
  REPO_ROOT,
  "packages/solana-spoke/target/deploy/hypersettle_spoke.so",
);
const IDL_PATH = join(
  REPO_ROOT,
  "packages/solana-spoke/target/idl/hypersettle_spoke.json",
);

const VALIDATOR_RPC_PORT = 8899;
const VALIDATOR_FAUCET_PORT = 9900;

const CONFIG_SEED = Buffer.from("config");
const TICKER_SEED = Buffer.from("ticker");
const VAULT_SEED = Buffer.from("vault");
const SPOKE_AUTHORITY_SEED = Buffer.from("spoke_authority");
const NONCE_SEED = Buffer.from("nonce");

export const SELF_DOMAIN = 7;
export const HUB_CHAIN = 1;
export const SELF_CHAIN = 1; // Solana spoke accepts orders with dest_chain == 1

export interface SolanaEnv {
  process: ChildProcessWithoutNullStreams;
  connection: Connection;
  provider: anchor.AnchorProvider;
  program: Program<any>;
  admin: Keypair;
  userB: Keypair;
  /// The keypair that actually signs SettlementOrders for the Solana spoke.
  /// On pre-alpha this is a local stand-in because the Ika MPC sign path
  /// isn't online yet; the spoke is initialized with this pubkey so unlocks
  /// can complete in the demo.
  signingKeypair: nacl.SignKeyPair;
  signingPubkey: PublicKey;
  /// The pubkey returned by Ika's real DKG (informational; not used to sign
  /// because we don't control the corresponding shares).
  ikaDkgPubkey: PublicKey | null;
  mint: PublicKey;
  configPda: PublicKey;
  tickerPda: PublicKey;
  vaultPda: PublicKey;
  spokeAuthorityPda: PublicKey;
  ticker: number[];
  assetHash: number[];
  shutdown: () => Promise<void>;
}

function loadProgramKeypair(): Keypair {
  const raw = JSON.parse(readFileSync(PROGRAM_KEYPAIR_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bytes32Label(label: string): number[] {
  const out = Buffer.alloc(32);
  Buffer.from(label).copy(out);
  return Array.from(out);
}

async function startValidator(programId: PublicKey): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    "solana-test-validator",
    [
      "--reset",
      "--rpc-port",
      String(VALIDATOR_RPC_PORT),
      "--faucet-port",
      String(VALIDATOR_FAUCET_PORT),
      "--gossip-port",
      "8801", // Avoid the default 8000 (often held by other dev servers).
      "--dynamic-port-range",
      "8810-8840",
      "--bpf-program",
      programId.toBase58(),
      PROGRAM_SO_PATH,
      "--ledger",
      `/tmp/hs-netting-ledger-${Date.now()}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Capture stderr/stdout so a validator-level startup error (port collision,
  // missing .so, etc) surfaces in the demo output instead of just timing out.
  let outBuf = "";
  child.stderr.on("data", (d) => {
    outBuf += d.toString();
  });
  child.stdout.on("data", (d) => {
    outBuf += d.toString();
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0 && code !== 137 /* SIGKILL */) {
      console.error(
        `solana-test-validator exited (code=${code}):\n${outBuf.slice(-3000)}`,
      );
    }
  });
  // Don't keep the parent process alive once we're done with the validator.
  child.unref();

  // Wait for the RPC to be live.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("solana-test-validator failed to start within 90s"));
    }, 90_000);
    const probe = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${VALIDATOR_RPC_PORT}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getHealth",
            params: [],
          }),
        });
        if (r.ok) {
          const body = (await r.json()) as { result?: string };
          if (body.result === "ok") {
            clearTimeout(t);
            clearInterval(probe);
            resolve();
          }
        }
      } catch {}
    }, 250);
  });

  return child;
}

export interface BringUpSolanaOpts {
  /// Optional: a pubkey returned by Ika's real DKG. Recorded for display
  /// but not used to sign because we don't hold the corresponding key shares.
  ikaDkgPubkey?: Uint8Array;
}

export async function bringUpSolana(opts: BringUpSolanaOpts = {}): Promise<SolanaEnv> {
  const programKeypair = loadProgramKeypair();
  const programId = programKeypair.publicKey;

  const proc = await startValidator(programId);
  const connection = new Connection(
    `http://127.0.0.1:${VALIDATOR_RPC_PORT}`,
    "confirmed",
  );

  const admin = Keypair.generate();
  const userB = Keypair.generate();

  // Airdrop SOL.
  for (const kp of [admin, userB]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 5_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const program = new Program(idl, provider) as Program<any>;

  // Local stand-in keypair used to actually sign settlement orders. On
  // pre-alpha Ika's MPC sign isn't online, so we register this pubkey on
  // the spoke and sign locally; the orchestrator separately exercises the
  // real Ika DKG against the live network for the demo's wire-path proof.
  const signingKeypair = nacl.sign.keyPair();
  const signingPubkey = new PublicKey(signingKeypair.publicKey);
  const ikaDkgPubkey = opts.ikaDkgPubkey ? new PublicKey(opts.ikaDkgPubkey) : null;

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  const [spokeAuthorityPda] = PublicKey.findProgramAddressSync(
    [SPOKE_AUTHORITY_SEED],
    programId,
  );

  // 1) Initialize config — register the local stand-in pubkey as ikaDwallet.
  await program.methods
    .initialize(signingPubkey, SELF_DOMAIN, HUB_CHAIN, SELF_CHAIN)
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 2) Create the SPL mock USDC mint.
  const mint = await createMint(connection, admin, admin.publicKey, null, 6);

  // 3) Bind ticker — use a UTF-8 label "USDC" padded to 32 bytes. The
  //    spoke only enforces that order.ticker matches the ticker_binding seed,
  //    not that it matches the EVM keccak. The two sides use different
  //    encodings of "USDC"; that's fine for this demo because each side
  //    independently routes by its own ticker.
  const ticker = bytes32Label("USDC");
  const assetHash = bytes32Label("solana:USDC");
  const [tickerPda] = PublicKey.findProgramAddressSync(
    [TICKER_SEED, Buffer.from(ticker)],
    programId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, Buffer.from(ticker)],
    programId,
  );

  await program.methods
    .bindTicker(ticker)
    .accounts({
      admin: admin.publicKey,
      config: configPda,
      mint,
      tickerBinding: tickerPda,
      spokeAuthority: spokeAuthorityPda,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // 4) Mint user B 500 mUSDC and pre-fund vault with 1000 mUSDC liquidity
  //    so the spoke can pay user A 101 mUSDC after netting.
  const userBAta = (
    await getOrCreateAssociatedTokenAccount(connection, admin, mint, userB.publicKey)
  ).address;
  await mintTo(connection, admin, mint, userBAta, admin, 500_000_000);
  await mintTo(connection, admin, mint, vaultPda, admin, 1_000_000_000);

  return {
    process: proc,
    connection,
    provider,
    program,
    admin,
    userB,
    signingKeypair,
    signingPubkey,
    ikaDkgPubkey,
    mint,
    configPda,
    tickerPda,
    vaultPda,
    spokeAuthorityPda,
    ticker,
    assetHash,
    shutdown: async () => {
      // SIGTERM is ignored by solana-test-validator's RPC threads; SIGKILL
      // is the only thing that releases the ports cleanly.
      proc.kill("SIGKILL");
    },
  };
}

export async function solanaDeposit(
  env: SolanaEnv,
  amountRaw: bigint,
  ctHandle: number[],
  epoch: bigint,
): Promise<{ txSig: string }> {
  const userAta = (
    await getOrCreateAssociatedTokenAccount(
      env.connection,
      env.admin,
      env.mint,
      env.userB.publicKey,
    )
  ).address;

  const txSig = await env.program.methods
    .deposit(env.ticker, env.assetHash, new BN(amountRaw.toString()), ctHandle, new BN(epoch.toString()))
    .accounts({
      user: env.userB.publicKey,
      config: env.configPda,
      tickerBinding: env.tickerPda,
      mint: env.mint,
      vault: env.vaultPda,
      userTokenAccount: userAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([env.userB])
    .rpc();

  return { txSig };
}

export async function solanaBalance(
  env: SolanaEnv,
  owner: PublicKey,
): Promise<bigint> {
  const ata = (
    await getOrCreateAssociatedTokenAccount(env.connection, env.admin, env.mint, owner)
  ).address;
  const acct = await getAccount(env.connection, ata);
  return acct.amount;
}

export async function solanaVaultBalance(env: SolanaEnv): Promise<bigint> {
  const acct = await getAccount(env.connection, env.vaultPda);
  return acct.amount;
}

/// Build the (ed25519 precompile, execute_settlement) instruction pair
/// the Solana spoke expects, using the demo's Ika ed25519 key.
export interface SolanaSettlementOrder {
  version: number;
  sourceChain: number;
  destChain: number;
  destDomain: number;
  ticker: number[];
  assetHash: number[];
  amount: bigint;
  recipient: number[]; // 32 bytes, the recipient's owner pubkey
  intentId: number[];
  nonce: bigint;
}

function borshSerializeSettlementOrder(o: SolanaSettlementOrder): Buffer {
  const buf = Buffer.alloc(1 + 2 + 2 + 4 + 32 + 32 + 8 + 32 + 32 + 8);
  let off = 0;
  buf.writeUInt8(o.version, off); off += 1;
  buf.writeUInt16LE(o.sourceChain, off); off += 2;
  buf.writeUInt16LE(o.destChain, off); off += 2;
  buf.writeUInt32LE(o.destDomain, off); off += 4;
  Buffer.from(o.ticker).copy(buf, off); off += 32;
  Buffer.from(o.assetHash).copy(buf, off); off += 32;
  buf.writeBigUInt64LE(o.amount, off); off += 8;
  Buffer.from(o.recipient).copy(buf, off); off += 32;
  Buffer.from(o.intentId).copy(buf, off); off += 32;
  buf.writeBigUInt64LE(o.nonce, off); off += 8;
  return buf;
}

export async function solanaExecuteSettlement(
  env: SolanaEnv,
  order: SolanaSettlementOrder,
  recipientOwner: PublicKey,
): Promise<string> {
  const message = borshSerializeSettlementOrder(order);
  const signature = nacl.sign.detached(message, env.signingKeypair.secretKey);

  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: env.signingKeypair.publicKey,
    message,
    signature,
  });

  const recipientAta = (
    await getOrCreateAssociatedTokenAccount(
      env.connection,
      env.admin,
      env.mint,
      recipientOwner,
    )
  ).address;

  const u64le = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const [noncePda] = PublicKey.findProgramAddressSync(
    [NONCE_SEED, u64le(order.nonce)],
    env.program.programId,
  );

  const orderForProgram = {
    version: order.version,
    sourceChain: order.sourceChain,
    destChain: order.destChain,
    destDomain: order.destDomain,
    ticker: order.ticker,
    assetHash: order.assetHash,
    amount: new BN(order.amount.toString()),
    recipient: order.recipient,
    intentId: order.intentId,
    nonce: new BN(order.nonce.toString()),
  };

  const executeIx = await env.program.methods
    .executeSettlement(orderForProgram)
    .accounts({
      payer: env.admin.publicKey,
      config: env.configPda,
      tickerBinding: env.tickerPda,
      mint: env.mint,
      vault: env.vaultPda,
      recipientTokenAccount: recipientAta,
      spokeAuthority: env.spokeAuthorityPda,
      consumedNonce: noncePda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction().add(ed25519Ix).add(executeIx);
  return sendAndConfirmTransaction(env.connection, tx, [env.admin]);
}
