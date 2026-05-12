// Testnet netting demo: runs the full deposit → net → sign → unlock cycle
// against real Base Sepolia + Solana Devnet using the contracts deployed by
// deploy-evm.ts and deploy-sol.ts.
//
// Demo amounts are scaled down to fit faucet-friendly liquidity (the deploy
// scripts mint 5 mUSDC of vault liquidity per side):
//   - User A deposits 1.01 mUSDC on Base Sepolia, wants payout on Solana.
//   - User B deposits 1.00 mUSDC on Solana,       wants payout on Base.
//   - Matched: 1.00. Surplus: 0.01 (base → solana).
//
// Same state server as the local demo so the /netting UI works.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";

import {
  evmSettlementDigest,
  type SettlementOrder,
} from "../../src/index.js";
import { ikaDkg, ikaTrySign, IKA_BASE_URL } from "../netting/ika.js";
import {
  StateServer,
  makeInitialState,
  type Phase,
} from "../netting/state-server.js";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const EVM_STATE_PATH = join(STATE_DIR, "evm.json");
const SOL_STATE_PATH = join(STATE_DIR, "sol.json");
const FORGE_OUT = join(REPO_ROOT, "packages/evm-spoke/out");
const IDL_PATH = join(REPO_ROOT, "packages/solana-spoke/target/idl/hypersettle_spoke.json");

const NONCE_SEED = Buffer.from("nonce");

const SCALE = 1_000_000n;
const PAUSE_MS = Number(process.env.HS_PAUSE_MS ?? 4000);
const DEPOSIT_EVM_RAW = 1010000n; // 1.01 mUSDC
const DEPOSIT_SOL_RAW = 1000000n; // 1.00 mUSDC

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
function loadAbi(name: string): any {
  return JSON.parse(readFileSync(join(FORGE_OUT, `${name}.sol`, `${name}.json`), "utf8")).abi;
}
function fmt(raw: bigint): string {
  const whole = raw / SCALE;
  const frac = (raw % SCALE).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
function fill32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(Buffer.from(label).slice(0, 32));
  return out;
}
function hexFromBytes(b: Uint8Array): Hex {
  return ("0x" + Buffer.from(b).toString("hex")) as Hex;
}
function paddedEvmAddr(addr: Hex): Uint8Array {
  const out = new Uint8Array(32);
  out.set(Buffer.from(addr.slice(2), "hex"), 12);
  return out;
}
function box(title: string) {
  const bar = "─".repeat(Math.max(48, title.length + 4));
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EvmState {
  rpc: string;
  operator: Address;
  spokeAddr: Address;
  usdcAddr: Address;
  ikaPrivateKey: Hex;
  ikaAddress: Address;
  ticker: Hex;
  assetHash: Hex;
  chainId: number;
  wormholeChainId: number;
  selfDomain: number;
}
interface SolState {
  rpc: string;
  operator: string;
  programId: string;
  configPda: string;
  spokeAuthorityPda: string;
  mint: string;
  tickerPda: string;
  vaultPda: string;
  signingPubkey: string;
  signingSecretKey: number[];
  selfDomain: number;
  hubChain: number;
  selfChain: number;
  ticker: number[];
  assetHash: number[];
}

function borshSerializeOrder(o: {
  version: number;
  sourceChain: number;
  destChain: number;
  destDomain: number;
  ticker: number[];
  assetHash: number[];
  amount: bigint;
  recipient: number[];
  intentId: number[];
  nonce: bigint;
}): Buffer {
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

async function main() {
  const evm = loadJson<EvmState>(EVM_STATE_PATH);
  const sol = loadJson<SolState>(SOL_STATE_PATH);

  const state = makeInitialState(IKA_BASE_URL, evm.chainId);
  const server = new StateServer(state);
  await server.start();
  console.log(`▸ Live state on http://localhost:${server.port}/state`);
  console.log(`▸ UI at        http://localhost:3000/netting`);

  process.on("SIGINT", () => {
    server.stop();
    process.exit(130);
  });
  const setPhase = (p: Phase) => server.patch((s) => (s.phase = p));

  try {
    server.patch((s) => {
      s.env.evm.spokeAddr = evm.spokeAddr;
      s.env.evm.usdcAddr = evm.usdcAddr;
      s.env.evm.ikaAddress = evm.ikaAddress;
      s.env.sol.spokeProgram = sol.programId;
      s.env.sol.mint = sol.mint;
      s.env.sol.signingPubkey = sol.signingPubkey;
    });

    setPhase("ika-dkg");
    box("Phase 0 · DKG against the live Ika network");
    const sender = fill32("hypersettle-testnet-netting");
    const dkg = await ikaDkg(sender);
    const dkgHex = "0x" + Buffer.from(dkg.publicKey).toString("hex");
    console.log(`  ✓ pubkey ${dkgHex} (${dkg.elapsedMs}ms)`);
    server.patch((s) => {
      s.ika.dkgPubkey = dkgHex;
      s.ika.dkgElapsedMs = dkg.elapsedMs;
      s.env.sol.ikaDkgPubkey = sol.signingPubkey; // displayed alongside the local stand-in
    });
    server.log("Ika DKG OK");
    await sleep(PAUSE_MS);

    // EVM clients
    const operatorAcc = privateKeyToAccount(JSON.parse(readFileSync(join(STATE_DIR, "operator-evm.json"), "utf8")).privateKey);
    const evmRecipientForB = privateKeyToAccount(generatePrivateKey()); // fresh user B EVM recipient
    server.patch((s) => {
      s.users.userAEvm = operatorAcc.address;
      s.users.userBEvmRecipient = evmRecipientForB.address;
    });
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(evm.rpc),
    });
    const evmWallet = createWalletClient({
      account: operatorAcc,
      chain: baseSepolia,
      transport: http(evm.rpc),
    });
    const usdcAbi = loadAbi("MockUSDC");
    const spokeAbi = loadAbi("HyperSettleSpoke");

    // Solana clients
    const operatorSol = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(join(STATE_DIR, "operator-sol.json"), "utf8")) as number[]),
    );
    const connection = new Connection(sol.rpc, "confirmed");
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(operatorSol), {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
    const program = new Program(idl, provider) as Program<any>;

    const userARecipientSol = Keypair.generate(); // fresh user A SOL recipient
    server.patch((s) => {
      s.users.userBSol = operatorSol.publicKey.toBase58();
      s.users.userASolRecipient = userARecipientSol.publicKey.toBase58();
    });

    // ── Phase 1: deposits ────────────────────────────────────────────
    setPhase("deposit-evm");
    box("Phase 1a · EVM deposit (Base Sepolia)");

    console.log("  approve usdc…");
    const approveHash = await evmWallet.writeContract({
      address: evm.usdcAddr,
      abi: usdcAbi,
      functionName: "approve",
      args: [evm.spokeAddr, DEPOSIT_EVM_RAW],
      account: operatorAcc,
      chain: baseSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`    ✓ approve tx ${approveHash}`);

    console.log("  deposit…");
    const depositHash = await evmWallet.writeContract({
      address: evm.spokeAddr,
      abi: spokeAbi,
      functionName: "deposit",
      args: [evm.ticker, evm.assetHash, DEPOSIT_EVM_RAW, hexFromBytes(fill32("ct-userA")), 1n],
      account: operatorAcc,
      chain: baseSepolia,
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
    const evmIntentEvents = parseEventLogs({
      abi: spokeAbi,
      eventName: "DepositPosted",
      logs: depositReceipt.logs,
    });
    const evmIntentId = ((evmIntentEvents[0]?.args as any)?.intentId ?? "0x") as Hex;
    console.log(`    ✓ deposit tx ${depositHash}  intent ${evmIntentId.slice(0, 14)}…`);
    server.patch((s) => {
      s.deposits.evm = {
        txHash: depositHash,
        intentId: evmIntentId,
        amountRaw: DEPOSIT_EVM_RAW.toString(),
      };
    });
    server.log(`EVM deposit confirmed (${fmt(DEPOSIT_EVM_RAW)} mUSDC)`);
    await sleep(PAUSE_MS);

    setPhase("deposit-sol");
    box("Phase 1b · Solana deposit (Devnet)");
    const operatorAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        operatorSol,
        new PublicKey(sol.mint),
        operatorSol.publicKey,
      )
    ).address;
    const depositSolSig = await program.methods
      .deposit(
        sol.ticker,
        sol.assetHash,
        new BN(DEPOSIT_SOL_RAW.toString()),
        Array.from(fill32("ct-userB")),
        new BN(1),
      )
      .accounts({
        user: operatorSol.publicKey,
        config: new PublicKey(sol.configPda),
        tickerBinding: new PublicKey(sol.tickerPda),
        mint: new PublicKey(sol.mint),
        vault: new PublicKey(sol.vaultPda),
        userTokenAccount: operatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`    ✓ deposit tx ${depositSolSig}`);
    server.patch((s) => {
      s.deposits.sol = { txSig: depositSolSig, amountRaw: DEPOSIT_SOL_RAW.toString() };
    });
    server.log(`Solana deposit confirmed (${fmt(DEPOSIT_SOL_RAW)} mUSDC)`);
    await sleep(PAUSE_MS);

    // ── Phase 2: net ─────────────────────────────────────────────────
    setPhase("net");
    box("Phase 2 · Net calculation");
    const baseToSol = DEPOSIT_EVM_RAW;
    const solToBase = DEPOSIT_SOL_RAW;
    const matched = baseToSol < solToBase ? baseToSol : solToBase;
    const surplus = baseToSol > solToBase ? baseToSol - solToBase : solToBase - baseToSol;
    const direction = (baseToSol > solToBase
      ? "base→solana"
      : solToBase > baseToSol
      ? "solana→base"
      : "flat") as "base→solana" | "solana→base" | "flat";
    console.log(`  matched ${fmt(matched)}  surplus ${fmt(surplus)}  ${direction}`);
    server.patch((s) => {
      s.net = {
        baseToSolRaw: baseToSol.toString(),
        solToBaseRaw: solToBase.toString(),
        matchedRaw: matched.toString(),
        surplusRaw: surplus.toString(),
        direction,
      };
    });
    server.log(`Net surplus ${fmt(surplus)} ${direction}`);
    await sleep(PAUSE_MS);

    // ── Phase 3a: probe Ika sign ─────────────────────────────────────
    setPhase("ika-sign-attempt");
    box("Phase 3a · Ika sign probe (SDK)");
    const probe = await ikaTrySign(sender, dkg.publicKey, fill32("probe"));
    if (probe.ok) {
      console.log(`  Ika returned ${probe.signature?.length ?? 0} bytes`);
    } else {
      console.log(`  Ika sign rejected: ${probe.error}`);
      server.patch((s) => (s.ika.signAttemptError = probe.error));
    }
    server.log(`Ika sign attempt: ${probe.ok ? "ok" : "rejected (pre-alpha)"}`);
    await sleep(PAUSE_MS);

    // ── Phase 3b: sign settlement orders ─────────────────────────────
    setPhase("sign");
    box("Phase 3b · Sign SettlementOrders");
    const evmOrder: SettlementOrder = {
      version: 1,
      sourceChain: sol.hubChain,
      destChain: evm.wormholeChainId,
      destDomain: evm.selfDomain,
      ticker: new Uint8Array(Buffer.from(evm.ticker.slice(2), "hex")),
      assetHash: new Uint8Array(Buffer.from(evm.assetHash.slice(2), "hex")),
      amount: matched,
      recipient: paddedEvmAddr(evmRecipientForB.address),
      intentId: fill32("net-evm"),
      nonce: BigInt(Date.now()), // use timestamp so reruns don't collide
    };
    const evmDigest = evmSettlementDigest(evmOrder);
    const ikaEvmAccount = privateKeyToAccount(evm.ikaPrivateKey);
    const evmSig = await ikaEvmAccount.sign({
      hash: ("0x" + Buffer.from(evmDigest).toString("hex")) as Hex,
    });
    console.log(`  ECDSA sig ${evmSig.slice(0, 14)}…`);
    server.patch((s) => {
      s.signatures.evmDigest = "0x" + Buffer.from(evmDigest).toString("hex");
      s.signatures.evmSig = evmSig;
    });

    const solOrderForBorsh = {
      version: 1,
      sourceChain: evm.wormholeChainId,
      destChain: sol.selfChain,
      destDomain: sol.selfDomain,
      ticker: sol.ticker,
      assetHash: sol.assetHash,
      amount: matched + surplus,
      recipient: Array.from(new Uint8Array(userARecipientSol.publicKey.toBytes())),
      intentId: Array.from(fill32("net-sol")),
      nonce: BigInt(Date.now() + 1),
    };
    const solSigningSecret = Uint8Array.from(sol.signingSecretKey);
    const solSigningPub = new Uint8Array(nacl.sign.keyPair.fromSecretKey(solSigningSecret).publicKey);
    console.log(`  ed25519 ready (signed inline inside unlock tx)`);
    server.log("Both orders signed");
    await sleep(PAUSE_MS);

    // ── Phase 4: unlocks ─────────────────────────────────────────────
    setPhase("unlock-evm");
    box("Phase 4a · Unlock EVM (executeSettlement)");
    const evmOrderForAbi = {
      version: evmOrder.version,
      sourceChain: evmOrder.sourceChain,
      destChain: evmOrder.destChain,
      destDomain: evmOrder.destDomain,
      ticker: hexFromBytes(evmOrder.ticker),
      assetHash: hexFromBytes(evmOrder.assetHash),
      amount: evmOrder.amount,
      recipient: hexFromBytes(evmOrder.recipient),
      intentId: hexFromBytes(evmOrder.intentId),
      nonce: evmOrder.nonce,
    };
    const unlockEvmHash = await evmWallet.writeContract({
      address: evm.spokeAddr,
      abi: spokeAbi,
      functionName: "executeSettlement",
      args: [evmOrderForAbi, evmSig],
      account: operatorAcc,
      chain: baseSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: unlockEvmHash });
    // Re-query a few times — public Base Sepolia RPC sometimes lags one
    // block behind getTransactionReceipt and returns the pre-tx balance.
    let userBOnEvm = 0n;
    for (let i = 0; i < 8; i++) {
      userBOnEvm = (await publicClient.readContract({
        address: evm.usdcAddr,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [evmRecipientForB.address],
      })) as bigint;
      if (userBOnEvm > 0n) break;
      await sleep(1500);
    }
    console.log(`    ✓ unlock tx ${unlockEvmHash}`);
    console.log(`    user B EVM balance: ${fmt(userBOnEvm)} mUSDC`);
    server.patch((s) => {
      s.unlocks.evm = { txHash: unlockEvmHash, amountRaw: matched.toString() };
      s.balances.userBOnEvmRaw = userBOnEvm.toString();
    });
    server.log(`EVM unlock confirmed (${fmt(userBOnEvm)})`);
    await sleep(PAUSE_MS);

    setPhase("unlock-sol");
    box("Phase 4b · Unlock Solana (execute_settlement)");
    const recipientAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        operatorSol,
        new PublicKey(sol.mint),
        userARecipientSol.publicKey,
      )
    ).address;

    const solMessage = borshSerializeOrder(solOrderForBorsh);
    const solSig = nacl.sign.detached(solMessage, solSigningSecret);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: solSigningPub,
      message: solMessage,
      signature: solSig,
    });

    const nonceU64Buf = Buffer.alloc(8);
    nonceU64Buf.writeBigUInt64LE(solOrderForBorsh.nonce);
    const [noncePda] = PublicKey.findProgramAddressSync(
      [NONCE_SEED, nonceU64Buf],
      new PublicKey(sol.programId),
    );

    const orderForProgram = {
      version: solOrderForBorsh.version,
      sourceChain: solOrderForBorsh.sourceChain,
      destChain: solOrderForBorsh.destChain,
      destDomain: solOrderForBorsh.destDomain,
      ticker: solOrderForBorsh.ticker,
      assetHash: solOrderForBorsh.assetHash,
      amount: new BN(solOrderForBorsh.amount.toString()),
      recipient: solOrderForBorsh.recipient,
      intentId: solOrderForBorsh.intentId,
      nonce: new BN(solOrderForBorsh.nonce.toString()),
    };

    const executeIx = await program.methods
      .executeSettlement(orderForProgram)
      .accounts({
        payer: operatorSol.publicKey,
        config: new PublicKey(sol.configPda),
        tickerBinding: new PublicKey(sol.tickerPda),
        mint: new PublicKey(sol.mint),
        vault: new PublicKey(sol.vaultPda),
        recipientTokenAccount: recipientAta,
        spokeAuthority: new PublicKey(sol.spokeAuthorityPda),
        consumedNonce: noncePda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(executeIx);
    const unlockSolSig = await sendAndConfirmTransaction(connection, tx, [operatorSol]);
    const recipientAcct = await getAccount(connection, recipientAta);
    const vaultAcct = await getAccount(connection, new PublicKey(sol.vaultPda));
    const userAOnSol = recipientAcct.amount;
    const solVault = vaultAcct.amount;

    console.log(`    ✓ unlock tx ${unlockSolSig}`);
    console.log(`    user A SOL balance: ${fmt(userAOnSol)} mUSDC`);
    server.patch((s) => {
      s.unlocks.sol = {
        txSig: unlockSolSig,
        amountRaw: (matched + surplus).toString(),
      };
      s.balances.userAOnSolRaw = userAOnSol.toString();
      s.balances.solVaultRaw = solVault.toString();
    });

    // EVM vault balance
    const evmVault = (await publicClient.readContract({
      address: evm.usdcAddr,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [evm.spokeAddr],
    })) as bigint;
    server.patch((s) => (s.balances.evmVaultRaw = evmVault.toString()));
    server.log(`Solana unlock confirmed (${fmt(userAOnSol)})`);
    await sleep(PAUSE_MS);

    setPhase("done");
    box("Done — testnet netting complete");
    console.log(`  user A on Solana : ${fmt(userAOnSol)} mUSDC`);
    console.log(`  user B on EVM    : ${fmt(userBOnEvm)} mUSDC`);
    console.log(`  EVM  vault       : ${fmt(evmVault)} mUSDC`);
    console.log(`  SOL  vault       : ${fmt(solVault)} mUSDC`);
    console.log(``);
    console.log(`  Net unlock       : ${fmt(surplus)} mUSDC  (${direction})`);
    console.log(``);
    console.log(`  EVM unlock tx    : https://sepolia.basescan.org/tx/${unlockEvmHash}`);
    console.log(`  SOL unlock tx    : https://explorer.solana.com/tx/${unlockSolSig}?cluster=devnet`);
    server.log("Done — testnet netting complete");

    console.log("\n▸ State remains live. Ctrl-C to shut down.");
    await new Promise(() => {});
  } catch (e) {
    server.log(`ERROR: ${(e as Error)?.message ?? String(e)}`);
    throw e;
  } finally {
    server.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
