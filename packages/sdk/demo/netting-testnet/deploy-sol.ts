// Solana devnet init: assumes the hypersettle_spoke program is already
// deployed via `anchor deploy --provider.cluster devnet`. Reads the program
// keypair from target/deploy/, initializes the spoke config with a freshly
// generated ed25519 Ika dWallet key, creates a mock-USDC SPL mint, binds
// the ticker, and mints liquidity to the operator + vault PDA.
//
// Writes addresses + the signing keypair to .netting-testnet/sol.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const OPERATOR_PATH = join(STATE_DIR, "operator-sol.json");
const SOL_STATE_PATH = join(STATE_DIR, "sol.json");

const PROGRAM_KEYPAIR_PATH = join(
  REPO_ROOT,
  "packages/solana-spoke/target/deploy/hypersettle_spoke-keypair.json",
);
const IDL_PATH = join(
  REPO_ROOT,
  "packages/solana-spoke/target/idl/hypersettle_spoke.json",
);

const RPC = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";

const SELF_DOMAIN = 7;
const HUB_CHAIN = 1;
const SELF_CHAIN = 1; // Solana
const SCALE_USDC = 1_000_000n;

const CONFIG_SEED = Buffer.from("config");
const TICKER_SEED = Buffer.from("ticker");
const VAULT_SEED = Buffer.from("vault");
const SPOKE_AUTHORITY_SEED = Buffer.from("spoke_authority");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function bytes32Label(label: string): number[] {
  const out = Buffer.alloc(32);
  Buffer.from(label).copy(out);
  return Array.from(out);
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const operator = loadKeypair(OPERATOR_PATH);
  const programKeypair = loadKeypair(PROGRAM_KEYPAIR_PATH);
  const programId = programKeypair.publicKey;

  const connection = new Connection(RPC, "confirmed");
  const bal = (await connection.getBalance(operator.publicKey)) / 1e9;
  console.log(`Operator   : ${operator.publicKey.toBase58()}`);
  console.log(`Balance    : ${bal} SOL`);
  console.log(`RPC        : ${RPC}`);
  console.log(`Program id : ${programId.toBase58()}`);

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(operator),
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const program = new Program(idl, provider) as Program<any>;

  // Fresh ed25519 keypair used for the Solana-side settlement signatures.
  // Real Ika MPC sign isn't online on pre-alpha yet, so we register a key
  // we control and sign locally for the unlock.
  const signingKeypair = nacl.sign.keyPair();
  const signingPubkey = new PublicKey(signingKeypair.publicKey);

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  const [spokeAuthorityPda] = PublicKey.findProgramAddressSync(
    [SPOKE_AUTHORITY_SEED],
    programId,
  );

  console.log("\nInitializing spoke config …");
  const initTx = await program.methods
    .initialize(signingPubkey, SELF_DOMAIN, HUB_CHAIN, SELF_CHAIN)
    .accounts({
      admin: operator.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✓ initialize tx ${initTx}`);

  console.log("\nCreating MockUSDC SPL mint (6 decimals) …");
  const mint = await createMint(connection, operator, operator.publicKey, null, 6);
  console.log(`  ✓ mint ${mint.toBase58()}`);

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

  console.log("\nBinding ticker …");
  const bindTx = await program.methods
    .bindTicker(ticker)
    .accounts({
      admin: operator.publicKey,
      config: configPda,
      mint,
      tickerBinding: tickerPda,
      spokeAuthority: spokeAuthorityPda,
      vault: vaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✓ bindTicker tx ${bindTx}`);

  console.log("\nMinting mUSDC liquidity …");
  const operatorAta = (
    await getOrCreateAssociatedTokenAccount(
      connection,
      operator,
      mint,
      operator.publicKey,
    )
  ).address;
  await mintTo(connection, operator, mint, operatorAta, operator, 5n * SCALE_USDC);
  console.log(`  ✓ operator ATA ${operatorAta.toBase58()}  (+5.000000)`);

  await mintTo(connection, operator, mint, vaultPda, operator, 5n * SCALE_USDC);
  console.log(`  ✓ vault         (+5.000000)`);

  const state = {
    network: "solana-devnet",
    rpc: RPC,
    operator: operator.publicKey.toBase58(),
    programId: programId.toBase58(),
    configPda: configPda.toBase58(),
    spokeAuthorityPda: spokeAuthorityPda.toBase58(),
    mint: mint.toBase58(),
    tickerPda: tickerPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    operatorAta: operatorAta.toBase58(),
    signingPubkey: signingPubkey.toBase58(),
    signingSecretKey: Array.from(signingKeypair.secretKey),
    selfDomain: SELF_DOMAIN,
    hubChain: HUB_CHAIN,
    selfChain: SELF_CHAIN,
    ticker,
    assetHash,
    deployedAt: new Date().toISOString(),
    deployTxs: { init: initTx, bindTicker: bindTx },
  };
  writeFileSync(SOL_STATE_PATH, JSON.stringify(state, null, 2));

  console.log("\n──────────────────────────────────────────────");
  console.log("  Solana devnet init complete");
  console.log("──────────────────────────────────────────────");
  console.log(`  Program  : https://explorer.solana.com/address/${programId.toBase58()}?cluster=devnet`);
  console.log(`  Mint     : https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);
  console.log(`  State    : ${SOL_STATE_PATH}`);
}

main().catch((e) => {
  console.error("Solana init failed:", e);
  process.exit(1);
});
