// Bind a second USDC ticker on the Solana spoke that matches what the
// frontend uses: keccak256("USDC") rather than the padded label. Frontend
// derives ticker_binding + vault PDAs from the keccak hash on both EVM
// and Solana for symmetry, so we add a parallel binding here.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const OPERATOR_PATH = join(STATE_DIR, "operator-sol.json");
const SOL_STATE_PATH = join(STATE_DIR, "sol.json");
const IDL_PATH = join(REPO_ROOT, "packages/solana-spoke/target/idl/hypersettle_spoke.json");

const TICKER_SEED = Buffer.from("ticker");
const VAULT_SEED = Buffer.from("vault");
const SPOKE_AUTHORITY_SEED = Buffer.from("spoke_authority");

async function main() {
  const sol = JSON.parse(readFileSync(SOL_STATE_PATH, "utf8"));
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(OPERATOR_PATH, "utf8")) as number[]),
  );
  const connection = new Connection(sol.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(operator),
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const program = new Program(idl, provider) as Program<any>;

  const programId = new PublicKey(sol.programId);
  const mint = new PublicKey(sol.mint);

  // keccak256("USDC") — same hash the frontend computes via viem.
  const tickerBytes = Buffer.from(keccak_256(Buffer.from("USDC")));
  const tickerArr = Array.from(tickerBytes);

  const [tickerPda] = PublicKey.findProgramAddressSync(
    [TICKER_SEED, tickerBytes],
    programId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, tickerBytes],
    programId,
  );
  const [spokeAuthorityPda] = PublicKey.findProgramAddressSync(
    [SPOKE_AUTHORITY_SEED],
    programId,
  );

  console.log("keccak ticker hex :", "0x" + tickerBytes.toString("hex"));
  console.log("ticker_binding PDA:", tickerPda.toBase58());
  console.log("vault PDA         :", vaultPda.toBase58());

  // Idempotent: if the PDA exists, skip the bind.
  const existing = await connection.getAccountInfo(tickerPda);
  if (existing) {
    console.log("ticker_binding already exists; skipping bind_ticker");
  } else {
    const txBind = await program.methods
      .bindTicker(tickerArr)
      .accounts({
        admin: operator.publicKey,
        config: new PublicKey(sol.configPda),
        mint,
        tickerBinding: tickerPda,
        spokeAuthority: spokeAuthorityPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("bindTicker tx     :", txBind);
  }

  // Pre-fund the new vault with 5 mUSDC liquidity (so unlocks can pay out).
  const SCALE = 1_000_000n;
  const txMint = await mintTo(connection, operator, mint, vaultPda, operator, 5n * SCALE);
  console.log("mint to new vault :", txMint);

  // Persist into sol.json so the orchestrator/UI can pick it up.
  const updated = {
    ...sol,
    tickerKeccak: "0x" + tickerBytes.toString("hex"),
    tickerKeccakPda: tickerPda.toBase58(),
    vaultKeccakPda: vaultPda.toBase58(),
  };
  writeFileSync(SOL_STATE_PATH, JSON.stringify(updated, null, 2));
  console.log("\nUpdated sol.json with the keccak ticker binding.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
