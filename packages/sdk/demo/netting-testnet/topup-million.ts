// Mint 1,000,000 mUSDC to both operator wallets so the orchestrator and
// /netting UI can run large demos without auto-top-ups slowing each cycle.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  getAccount,
  mintTo,
} from "@solana/spl-token";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const FORGE_OUT = join(REPO_ROOT, "packages/evm-spoke/out");

const TARGET_HUMAN = 1_000_000n;
const SCALE = 1_000_000n; // 6 decimals
const TARGET_RAW = TARGET_HUMAN * SCALE;

function loadAbi(name: string): any {
  return JSON.parse(readFileSync(join(FORGE_OUT, `${name}.sol`, `${name}.json`), "utf8")).abi;
}

async function evmTopup() {
  const evm = JSON.parse(readFileSync(join(STATE_DIR, "evm.json"), "utf8"));
  const opKey = JSON.parse(readFileSync(join(STATE_DIR, "operator-evm.json"), "utf8"));
  const operator = privateKeyToAccount(opKey.privateKey as Hex);

  const usdcAbi = loadAbi("MockUSDC");
  const pc = createPublicClient({ chain: baseSepolia, transport: http(evm.rpc) });
  const wc = createWalletClient({ account: operator, chain: baseSepolia, transport: http(evm.rpc) });

  const cur = (await pc.readContract({
    address: evm.usdcAddr, abi: usdcAbi, functionName: "balanceOf", args: [operator.address],
  })) as bigint;

  console.log(`EVM operator ${operator.address}`);
  console.log(`  current : ${cur / SCALE} mUSDC (${cur})`);

  if (cur >= TARGET_RAW) {
    console.log(`  ≥ ${TARGET_HUMAN}, nothing to do.`);
    return;
  }
  const need = TARGET_RAW - cur;
  const hash = await wc.writeContract({
    address: evm.usdcAddr,
    abi: usdcAbi,
    functionName: "mint",
    args: [operator.address, need],
    account: operator,
    chain: baseSepolia,
  });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`mint reverted: ${hash}`);
  const after = (await pc.readContract({
    address: evm.usdcAddr, abi: usdcAbi, functionName: "balanceOf", args: [operator.address],
  })) as bigint;
  console.log(`  ✓ minted ${need / SCALE} mUSDC → balance ${after / SCALE}`);
  console.log(`  tx: https://sepolia.basescan.org/tx/${hash}`);
}

async function solTopup() {
  const sol = JSON.parse(readFileSync(join(STATE_DIR, "sol.json"), "utf8"));
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(STATE_DIR, "operator-sol.json"), "utf8")) as number[]),
  );
  const connection = new Connection(sol.rpc, "confirmed");
  const mint = new PublicKey(sol.mint);

  const ata = await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    operator.publicKey,
  );
  const cur = (await getAccount(connection, ata)).amount;

  console.log(`\nSolana operator ${operator.publicKey.toBase58()}`);
  console.log(`  current : ${Number(cur) / 1e6} mUSDC (${cur})`);

  if (cur >= TARGET_RAW) {
    console.log(`  ≥ ${TARGET_HUMAN}, nothing to do.`);
    return;
  }
  const need = TARGET_RAW - cur;
  const sig = await mintTo(connection, operator, mint, ata, operator, Number(need));
  const after = (await getAccount(connection, ata)).amount;
  console.log(`  ✓ minted ${Number(need) / 1e6} mUSDC → balance ${Number(after) / 1e6}`);
  console.log(`  tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

async function main() {
  await evmTopup();
  await solTopup();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
