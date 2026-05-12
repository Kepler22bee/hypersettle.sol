import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";

const PROGRAM_ID = new PublicKey("4YbN6dZNNgvRDnYtASGyto69S1gxJB5mZnFS1tpvDHGw");
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const CONFIG_SEED = Buffer.from("config");
const TICKER_SEED = Buffer.from("ticker");
const VAULT_SEED = Buffer.from("vault");
const SPOKE_AUTHORITY_SEED = Buffer.from("spoke_authority");
const INITIALIZE_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const BIND_TICKER_DISCRIMINATOR = Buffer.from([171, 137, 8, 205, 150, 45, 163, 139]);

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function bytes32(label: string): number[] {
  const out = Buffer.alloc(32);
  Buffer.from(label).copy(out);
  return Array.from(out);
}

function hex32(value: string): Buffer {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  const out = Buffer.from(hex, "hex");
  if (out.length !== 32) throw new Error(`expected 32 bytes, got ${out.length}`);
  return out;
}

function u16le(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

async function main() {
  const keypairPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
  const ticker = hex32("0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa");
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const [tickerPda] = PublicKey.findProgramAddressSync(
    [TICKER_SEED, ticker],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, ticker],
    PROGRAM_ID,
  );
  const [spokeAuthorityPda] = PublicKey.findProgramAddressSync(
    [SPOKE_AUTHORITY_SEED],
    PROGRAM_ID,
  );

  const configInfo = await connection.getAccountInfo(configPda);
  if (!configInfo) {
    const data = Buffer.concat([
      INITIALIZE_DISCRIMINATOR,
      payer.publicKey.toBuffer(), // temporary Ika dWallet placeholder for devnet
      u32le(7), // self_domain
      u16le(1), // hub_chain: Solana
      u16le(1), // self_chain: Solana devnet Wormhole id
    ]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
    console.log("Initialized config:", configPda.toBase58());
    console.log("Initialize tx:", sig);
  } else {
    console.log("Config already exists:", configPda.toBase58());
  }

  const tickerInfo = await connection.getAccountInfo(tickerPda);
  if (!tickerInfo) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: USDC_DEVNET, isSigner: false, isWritable: false },
        { pubkey: tickerPda, isSigner: false, isWritable: true },
        { pubkey: spokeAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([BIND_TICKER_DISCRIMINATOR, ticker]),
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
    console.log("Bound USDC ticker:", tickerPda.toBase58());
    console.log("Bind ticker tx:", sig);
  } else {
    console.log("USDC ticker already bound:", tickerPda.toBase58());
  }

  console.log("Vault:", vaultPda.toBase58());
  console.log("NEXT_PUBLIC_SOLANA_SPOKE_PROGRAM_ID=%s", PROGRAM_ID.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
