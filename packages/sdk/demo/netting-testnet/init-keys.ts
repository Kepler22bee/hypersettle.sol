// Generate fresh operator keypairs for the testnet demo and print their
// public addresses. The secrets are written to .netting-testnet/ which is
// gitignored. This file is the only "owner" of those keys — fund the
// addresses below, then run deploy-evm.ts / deploy-sol.ts.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const EVM_KEY_PATH = join(STATE_DIR, "operator-evm.json");
const SOL_KEY_PATH = join(STATE_DIR, "operator-sol.json");

mkdirSync(STATE_DIR, { recursive: true });

let evmPrivateKey: `0x${string}`;
if (existsSync(EVM_KEY_PATH)) {
  const j = JSON.parse(readFileSync(EVM_KEY_PATH, "utf8"));
  evmPrivateKey = j.privateKey;
  console.log("• EVM operator: reusing existing key from", EVM_KEY_PATH);
} else {
  evmPrivateKey = generatePrivateKey();
  writeFileSync(
    EVM_KEY_PATH,
    JSON.stringify(
      { privateKey: evmPrivateKey, address: privateKeyToAccount(evmPrivateKey).address },
      null,
      2,
    ),
  );
  console.log("• EVM operator: generated new key at", EVM_KEY_PATH);
}
const evmAddress = privateKeyToAccount(evmPrivateKey).address;

let solKeypair: Keypair;
if (existsSync(SOL_KEY_PATH)) {
  const raw = JSON.parse(readFileSync(SOL_KEY_PATH, "utf8")) as number[];
  solKeypair = Keypair.fromSecretKey(Uint8Array.from(raw));
  console.log("• Solana operator: reusing existing key from", SOL_KEY_PATH);
} else {
  solKeypair = Keypair.generate();
  writeFileSync(SOL_KEY_PATH, JSON.stringify(Array.from(solKeypair.secretKey)));
  console.log("• Solana operator: generated new key at", SOL_KEY_PATH);
}

console.log("\n──────────────────────────────────────────────");
console.log("  Fund these addresses on the testnets");
console.log("──────────────────────────────────────────────\n");

console.log("Base Sepolia (need ~0.05 testnet ETH for gas)");
console.log("  Address:", evmAddress);
console.log("  Faucets:");
console.log("    https://www.alchemy.com/faucets/base-sepolia");
console.log("    https://faucet.quicknode.com/base/sepolia");
console.log("    https://docs.base.org/docs/tools/network-faucets/\n");

console.log("Solana Devnet (need ~3 SOL for program deploy + SPL ops)");
console.log("  Address:", solKeypair.publicKey.toBase58());
console.log("  Faucet:");
console.log(`    solana airdrop 2 ${solKeypair.publicKey.toBase58()} --url devnet`);
console.log("    (rate-limited; may need to retry a few times)");
console.log("    https://faucet.solana.com\n");

console.log("Mock USDC is deployed by us on both sides — you do NOT need real USDC.\n");
console.log("Once funded, run:");
console.log("  pnpm demo:netting:testnet:deploy:evm");
console.log("  pnpm demo:netting:testnet:deploy:sol");
console.log("  pnpm demo:netting:testnet");
