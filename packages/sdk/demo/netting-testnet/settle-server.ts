// Settlement HTTP service.
//
// Loads the Ika dWallet keys from .netting-testnet/ and exposes a small
// HTTP endpoint the frontend's /settle page can POST to.
//
//   POST http://localhost:7071/settle
//   body: {
//     baseToSol: { amountRaw: "1010000", recipientSol: "<base58>" } | null,
//     solToBase: { amountRaw: "1000000", recipientEvm: "0x<addr>" } | null
//   }
//
// Response (on success):
//   {
//     ok: true,
//     matchedRaw, surplusRaw, direction,
//     evmUnlock: { txHash, recipient, amountRaw, explorer } | null,
//     solUnlock: { txSig,  recipient, amountRaw, explorer } | null,
//     balances: { userBOnEvmRaw, userAOnSolRaw, evmVaultRaw, solVaultRaw }
//   }

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

import { evmSettlementDigest, type SettlementOrder } from "../../src/index.js";
import { ikaDkg, ikaTrySign, IKA_BASE_URL } from "../netting/ika.js";
import { generatePrivateKey } from "viem/accounts";
import {
  parseEventLogs,
} from "viem";
import { mintTo } from "@solana/spl-token";
import { Transaction as SolTx, TransactionInstruction } from "@solana/web3.js";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const EVM_STATE_PATH = join(STATE_DIR, "evm.json");
const SOL_STATE_PATH = join(STATE_DIR, "sol.json");
const FORGE_OUT = join(REPO_ROOT, "packages/evm-spoke/out");
const IDL_PATH = join(REPO_ROOT, "packages/solana-spoke/target/idl/hypersettle_spoke.json");

const PORT = Number(process.env.HS_SETTLE_PORT ?? 7071);
const NONCE_SEED = Buffer.from("nonce");

// ── In-memory demo state (shape mirrors state-server.ts so the existing
// /netting frontend renders it verbatim). ───────────────────────────────
type Phase =
  | "init" | "ika-dkg" | "boot"
  | "deposit-evm" | "deposit-sol"
  | "net"
  | "ika-sign-attempt" | "sign"
  | "unlock-evm" | "unlock-sol"
  | "done" | "error";

interface DemoState {
  phase: Phase;
  startedAt: string;
  ika: {
    endpoint: string;
    dkgPubkey: string | null;
    dkgElapsedMs: number | null;
    signAttemptError: string | null;
  };
  env: {
    evm: { spokeAddr: string | null; usdcAddr: string | null; ikaAddress: string | null; chainId: number };
    sol: { spokeProgram: string | null; mint: string | null; signingPubkey: string | null; ikaDkgPubkey: string | null };
  };
  users: {
    userAEvm: string | null;
    userASolRecipient: string | null;
    userBSol: string | null;
    userBEvmRecipient: string | null;
  };
  deposits: {
    evm: { txHash: string; intentId: string; amountRaw: string } | null;
    sol: { txSig: string; amountRaw: string } | null;
  };
  net: { baseToSolRaw: string; solToBaseRaw: string; matchedRaw: string; surplusRaw: string; direction: string } | null;
  signatures: { evmDigest: string | null; evmSig: string | null };
  unlocks: {
    evm: { txHash: string; amountRaw: string } | null;
    sol: { txSig: string; amountRaw: string } | null;
  };
  balances: {
    userAOnSolRaw: string | null;
    userBOnEvmRaw: string | null;
    evmVaultRaw: string | null;
    solVaultRaw: string | null;
  };
  log: { ts: string; msg: string }[];
  errorMsg?: string;
}

function freshState(): DemoState {
  return {
    phase: "init",
    startedAt: new Date().toISOString(),
    ika: { endpoint: IKA_BASE_URL, dkgPubkey: null, dkgElapsedMs: null, signAttemptError: null },
    env: {
      evm: { spokeAddr: null, usdcAddr: null, ikaAddress: null, chainId: 84532 },
      sol: { spokeProgram: null, mint: null, signingPubkey: null, ikaDkgPubkey: null },
    },
    users: { userAEvm: null, userASolRecipient: null, userBSol: null, userBEvmRecipient: null },
    deposits: { evm: null, sol: null },
    net: null,
    signatures: { evmDigest: null, evmSig: null },
    unlocks: { evm: null, sol: null },
    balances: { userAOnSolRaw: null, userBOnEvmRaw: null, evmVaultRaw: null, solVaultRaw: null },
    log: [],
  };
}

const state: { current: DemoState; busy: boolean } = {
  current: freshState(),
  busy: false,
};

// Cache the Ika DKG result across runs so a flaky pre-alpha endpoint doesn't
// block subsequent demos. Cleared by /reset.
let ikaCache: Awaited<ReturnType<typeof ikaDkg>> | null = null;

function patch(fn: (s: DemoState) => void) { fn(state.current); }
function logMsg(msg: string) {
  state.current.log.push({ ts: new Date().toISOString(), msg });
  if (state.current.log.length > 200) state.current.log.shift();
}

const PAUSE_MS = Number(process.env.HS_PAUSE_MS ?? 2000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadAbi(name: string): any {
  return JSON.parse(readFileSync(join(FORGE_OUT, `${name}.sol`, `${name}.json`), "utf8")).abi;
}
function hexFromBytes(b: Uint8Array): Hex {
  return ("0x" + Buffer.from(b).toString("hex")) as Hex;
}
function paddedEvmAddr(addr: Hex): Uint8Array {
  const out = new Uint8Array(32);
  out.set(Buffer.from(addr.slice(2), "hex"), 12);
  return out;
}
function fill32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(Buffer.from(label).slice(0, 32));
  return out;
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

interface EvmCtx {
  rpc: string;
  spokeAddr: Hex;
  usdcAddr: Hex;
  ikaPrivateKey: Hex;
  ticker: Hex;
  assetHash: Hex;
  wormholeChainId: number;
  selfDomain: number;
  operatorPriv: Hex;
}
interface SolCtx {
  rpc: string;
  programId: string;
  configPda: string;
  spokeAuthorityPda: string;
  mint: string;
  tickerKeccak: string;
  tickerKeccakPda: string;
  vaultKeccakPda: string;
  signingSecretKey: number[];
  selfChain: number;
  selfDomain: number;
}

function loadCtx() {
  const evm = JSON.parse(readFileSync(EVM_STATE_PATH, "utf8"));
  const sol = JSON.parse(readFileSync(SOL_STATE_PATH, "utf8"));
  const opEvm = JSON.parse(readFileSync(join(STATE_DIR, "operator-evm.json"), "utf8"));
  if (!sol.tickerKeccak || !sol.vaultKeccakPda) {
    throw new Error(
      "sol.json missing keccak ticker — run `pnpm exec tsx demo/netting-testnet/rebind-sol-keccak.ts` first.",
    );
  }
  const evmCtx: EvmCtx = {
    rpc: evm.rpc,
    spokeAddr: evm.spokeAddr,
    usdcAddr: evm.usdcAddr,
    ikaPrivateKey: evm.ikaPrivateKey,
    ticker: evm.ticker,
    assetHash: evm.assetHash,
    wormholeChainId: evm.wormholeChainId,
    selfDomain: evm.selfDomain,
    operatorPriv: opEvm.privateKey,
  };
  const solCtx: SolCtx = {
    rpc: sol.rpc,
    programId: sol.programId,
    configPda: sol.configPda,
    spokeAuthorityPda: sol.spokeAuthorityPda,
    mint: sol.mint,
    tickerKeccak: sol.tickerKeccak,
    tickerKeccakPda: sol.tickerKeccakPda,
    vaultKeccakPda: sol.vaultKeccakPda,
    signingSecretKey: sol.signingSecretKey,
    selfChain: sol.selfChain,
    selfDomain: sol.selfDomain,
  };
  return { evm: evmCtx, sol: solCtx };
}

async function settle(req: {
  baseToSol: { amountRaw: string; recipientSol: string } | null;
  solToBase: { amountRaw: string; recipientEvm: string } | null;
}) {
  const { evm, sol } = loadCtx();

  const baseToSolRaw = BigInt(req.baseToSol?.amountRaw ?? "0");
  const solToBaseRaw = BigInt(req.solToBase?.amountRaw ?? "0");
  const matched = baseToSolRaw < solToBaseRaw ? baseToSolRaw : solToBaseRaw;
  const surplus =
    baseToSolRaw > solToBaseRaw ? baseToSolRaw - solToBaseRaw : solToBaseRaw - baseToSolRaw;
  const direction =
    baseToSolRaw > solToBaseRaw
      ? "base→solana"
      : solToBaseRaw > baseToSolRaw
      ? "solana→base"
      : "flat";

  const evmPayoutAmt =
    direction === "solana→base" ? matched + surplus : matched;
  const solPayoutAmt =
    direction === "base→solana" ? matched + surplus : matched;

  // ── EVM unlock (pays user B on Base Sepolia) ─────────────────────
  const operator = privateKeyToAccount(evm.operatorPriv);
  const ikaEvm = privateKeyToAccount(evm.ikaPrivateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(evm.rpc) });
  const evmWallet = createWalletClient({
    account: operator,
    chain: baseSepolia,
    transport: http(evm.rpc),
  });
  const spokeAbi = loadAbi("HyperSettleSpoke");
  const usdcAbi = loadAbi("MockUSDC");

  // ── Vault liquidity top-ups so larger amounts unlock cleanly ─────
  const spokeAbiForTopup = spokeAbi;
  if (evmPayoutAmt > 0n) {
    const vaultBal = (await publicClient.readContract({
      address: evm.usdcAddr, abi: usdcAbi, functionName: "balanceOf", args: [evm.spokeAddr],
    })) as bigint;
    if (vaultBal < evmPayoutAmt) {
      const need = evmPayoutAmt - vaultBal + 1_000_000n;
      const mintH = await evmWallet.writeContract({
        address: evm.usdcAddr, abi: usdcAbi,
        functionName: "mint", args: [evm.spokeAddr, need],
        account: operator, chain: baseSepolia,
      });
      const r = await publicClient.waitForTransactionReceipt({ hash: mintH });
      if (r.status !== "success") throw new Error(`vault top-up reverted: ${mintH}`);
      console.log(`topped up EVM vault by ${need}`);
    }
  }
  if (solPayoutAmt > 0n) {
    const conn2 = new Connection(sol.rpc, "confirmed");
    const opSol = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(join(STATE_DIR, "operator-sol.json"), "utf8")) as number[]),
    );
    const vAcct = await getAccount(conn2, new PublicKey(sol.vaultKeccakPda));
    if (vAcct.amount < solPayoutAmt) {
      const need = solPayoutAmt - vAcct.amount + 1_000_000n;
      await mintTo(conn2, opSol, new PublicKey(sol.mint), new PublicKey(sol.vaultKeccakPda), opSol, Number(need));
      console.log(`topped up SOL vault by ${need}`);
    }
  }

  let evmUnlock: any = null;
  if (req.solToBase) {
    const order: SettlementOrder = {
      version: 1,
      sourceChain: 1, // Solana
      destChain: evm.wormholeChainId,
      destDomain: evm.selfDomain,
      ticker: new Uint8Array(Buffer.from(evm.ticker.slice(2), "hex")),
      assetHash: new Uint8Array(Buffer.from(evm.assetHash.slice(2), "hex")),
      amount: evmPayoutAmt,
      recipient: paddedEvmAddr(req.solToBase.recipientEvm as Hex),
      intentId: fill32("net-evm-" + Date.now()),
      nonce: BigInt(Date.now()),
    };
    const digest = evmSettlementDigest(order);
    const sig = await ikaEvm.sign({ hash: ("0x" + Buffer.from(digest).toString("hex")) as Hex });
    const orderAbi = {
      version: order.version,
      sourceChain: order.sourceChain,
      destChain: order.destChain,
      destDomain: order.destDomain,
      ticker: hexFromBytes(order.ticker),
      assetHash: hexFromBytes(order.assetHash),
      amount: order.amount,
      recipient: hexFromBytes(order.recipient),
      intentId: hexFromBytes(order.intentId),
      nonce: order.nonce,
    };
    const txHash = await evmWallet.writeContract({
      address: evm.spokeAddr,
      abi: spokeAbi,
      functionName: "executeSettlement",
      args: [orderAbi, sig],
      account: operator,
      chain: baseSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    evmUnlock = {
      txHash,
      recipient: req.solToBase.recipientEvm,
      amountRaw: evmPayoutAmt.toString(),
      explorer: `https://sepolia.basescan.org/tx/${txHash}`,
    };
  }

  // ── Solana unlock (pays user A on Devnet) ─────────────────────────
  const operatorSol = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(STATE_DIR, "operator-sol.json"), "utf8")) as number[]),
  );
  const connection = new Connection(sol.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(operatorSol),
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const program = new Program(idl, provider) as Program<any>;
  const signingSecret = Uint8Array.from(sol.signingSecretKey);
  const signingPub = new Uint8Array(nacl.sign.keyPair.fromSecretKey(signingSecret).publicKey);

  let solUnlock: any = null;
  if (req.baseToSol) {
    // Borsh order uses the keccak ticker bytes for symmetry with EVM
    const tickerBytes = Array.from(Buffer.from(sol.tickerKeccak.slice(2), "hex"));
    const assetBytes = Array.from(fill32("solana:USDC"));
    const recipientPk = new PublicKey(req.baseToSol.recipientSol);
    const order = {
      version: 1,
      sourceChain: evm.wormholeChainId,
      destChain: sol.selfChain,
      destDomain: sol.selfDomain,
      ticker: tickerBytes,
      assetHash: assetBytes,
      amount: solPayoutAmt,
      recipient: Array.from(new Uint8Array(recipientPk.toBytes())),
      intentId: Array.from(fill32("net-sol-" + Date.now())),
      nonce: BigInt(Date.now() + 1),
    };
    const msg = borshSerializeOrder(order);
    const sig = nacl.sign.detached(msg, signingSecret);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signingPub,
      message: msg,
      signature: sig,
    });
    const recipientAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        operatorSol,
        new PublicKey(sol.mint),
        recipientPk,
      )
    ).address;
    const nonceLe = Buffer.alloc(8); nonceLe.writeBigUInt64LE(order.nonce);
    const [noncePda] = PublicKey.findProgramAddressSync(
      [NONCE_SEED, nonceLe],
      new PublicKey(sol.programId),
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
    const execIx = await program.methods
      .executeSettlement(orderForProgram)
      .accounts({
        payer: operatorSol.publicKey,
        config: new PublicKey(sol.configPda),
        tickerBinding: new PublicKey(sol.tickerKeccakPda),
        mint: new PublicKey(sol.mint),
        vault: new PublicKey(sol.vaultKeccakPda),
        recipientTokenAccount: recipientAta,
        spokeAuthority: new PublicKey(sol.spokeAuthorityPda),
        consumedNonce: noncePda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx = new Transaction().add(ed25519Ix).add(execIx);
    const txSig = await sendAndConfirmTransaction(connection, tx, [operatorSol]);
    const recipientAcct = await getAccount(connection, recipientAta);
    solUnlock = {
      txSig,
      recipient: req.baseToSol.recipientSol,
      amountRaw: solPayoutAmt.toString(),
      recipientBalanceRaw: recipientAcct.amount.toString(),
      explorer: `https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
    };
  }

  // Final balance snapshot
  const evmVault = (await publicClient.readContract({
    address: evm.usdcAddr,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [evm.spokeAddr],
  })) as bigint;
  const userBOnEvm = req.solToBase
    ? ((await publicClient.readContract({
        address: evm.usdcAddr,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [req.solToBase.recipientEvm as Hex],
      })) as bigint)
    : 0n;
  const vaultAcct = await getAccount(connection, new PublicKey(sol.vaultKeccakPda));
  const solVault = vaultAcct.amount;
  const userAOnSol = solUnlock ? BigInt(solUnlock.recipientBalanceRaw) : 0n;

  return {
    ok: true as const,
    matchedRaw: matched.toString(),
    surplusRaw: surplus.toString(),
    direction,
    evmUnlock,
    solUnlock,
    balances: {
      userBOnEvmRaw: userBOnEvm.toString(),
      userAOnSolRaw: userAOnSol.toString(),
      evmVaultRaw: evmVault.toString(),
      solVaultRaw: solVault.toString(),
    },
  };
}

// ── Top-of-flow runner: do EVM + Solana deposits with user-supplied
// amounts, then run the unlock sequence. Drives the demo state so the
// /netting page renders the live progression. ────────────────────────
async function runDemo(req: { baseAmountRaw: string; solAmountRaw: string }) {
  state.busy = true;
  state.current = freshState();

  try {
    const { evm, sol } = loadCtx();
    const baseAmount = BigInt(req.baseAmountRaw);
    const solAmount = BigInt(req.solAmountRaw);

    // ── env summary ──
    patch((s) => {
      s.env.evm.spokeAddr = evm.spokeAddr;
      s.env.evm.usdcAddr = evm.usdcAddr;
      // Ika address derived later from privKey — record now
      s.env.evm.ikaAddress = privateKeyToAccount(evm.ikaPrivateKey).address;
      s.env.sol.spokeProgram = sol.programId;
      s.env.sol.mint = sol.mint;
      // Signing pubkey from the secret bytes (compact representation)
      s.env.sol.signingPubkey = new PublicKey(
        nacl.sign.keyPair.fromSecretKey(Uint8Array.from(sol.signingSecretKey)).publicKey,
      ).toBase58();
    });

    // ── recipients fresh per run ──
    const userBRecipientEvm = privateKeyToAccount(generatePrivateKey());
    const userARecipientSol = Keypair.generate();

    patch((s) => {
      s.users.userAEvm = privateKeyToAccount(evm.operatorPriv).address;
      s.users.userASolRecipient = userARecipientSol.publicKey.toBase58();
      s.users.userBEvmRecipient = userBRecipientEvm.address;
    });

    // ── Phase 0 · Ika DKG (cached + best-effort) ──
    patch((s) => (s.phase = "ika-dkg"));
    const sender = fill32("hypersettle-netting-ui");
    let dkg: Awaited<ReturnType<typeof ikaDkg>> | null = ikaCache;
    if (!dkg) {
      logMsg(`Ika DKG against ${IKA_BASE_URL}…`);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          dkg = await ikaDkg(sender);
          ikaCache = dkg;
          break;
        } catch (e: any) {
          logMsg(`Ika DKG attempt ${attempt + 1} failed: ${e?.message ?? String(e)}`);
          if (attempt < 2) await sleep(3000);
        }
      }
    } else {
      logMsg(`Ika DKG (cached from earlier this session)`);
    }
    if (!dkg) {
      // Pre-alpha endpoint outage. Continue with a null pubkey — the rest of
      // the flow uses our local stand-in key for the actual signing.
      logMsg("Ika devnet unreachable; continuing without DKG attestation");
      patch((s) => (s.ika.signAttemptError = "Ika devnet 504"));
    } else {
      const dkgHex = "0x" + Buffer.from(dkg.publicKey).toString("hex");
      patch((s) => {
        s.ika.dkgPubkey = dkgHex;
        s.ika.dkgElapsedMs = dkg!.elapsedMs;
        s.env.sol.ikaDkgPubkey = dkgHex;
      });
      logMsg(`Ika DKG OK (${dkg.elapsedMs}ms)`);
    }
    await sleep(PAUSE_MS);

    // ── Phase 1a · Deposit on Base Sepolia ──
    if (baseAmount > 0n) {
      patch((s) => (s.phase = "deposit-evm"));
      logMsg(`Approve + deposit ${baseAmount} (raw) on Base Sepolia`);

      const operator = privateKeyToAccount(evm.operatorPriv);
      const pc = createPublicClient({ chain: baseSepolia, transport: http(evm.rpc) });
      const wc = createWalletClient({ account: operator, chain: baseSepolia, transport: http(evm.rpc) });
      const usdcAbi = loadAbi("MockUSDC");
      const spokeAbi = loadAbi("HyperSettleSpoke");

      async function send(label: string, hash: Hex) {
        const rcp = await pc.waitForTransactionReceipt({ hash });
        if (rcp.status !== "success") {
          throw new Error(`${label} reverted on Base Sepolia: ${hash}`);
        }
        return rcp;
      }

      // Top up MockUSDC if operator is short. MockUSDC.mint is open by design.
      const balOp = (await pc.readContract({
        address: evm.usdcAddr, abi: usdcAbi, functionName: "balanceOf", args: [operator.address],
      })) as bigint;
      if (balOp < baseAmount) {
        const mintH = await wc.writeContract({
          address: evm.usdcAddr, abi: usdcAbi,
          functionName: "mint", args: [operator.address, baseAmount - balOp + 1_000_000n],
          account: operator, chain: baseSepolia,
        });
        await send("mint", mintH);
        logMsg(`Topped up operator mUSDC (mint tx ${mintH.slice(0,12)}…)`);
      }

      // Reset allowance to 0 first to avoid edge-cases on tokens that disallow
      // allowance->allowance changes (most OZ ERC20s allow it, but doing this
      // makes the approve idempotent regardless of any stale prior allowance).
      const currentAllowance = (await pc.readContract({
        address: evm.usdcAddr, abi: usdcAbi, functionName: "allowance",
        args: [operator.address, evm.spokeAddr],
      })) as bigint;
      if (currentAllowance > 0n && currentAllowance < baseAmount) {
        const zeroH = await wc.writeContract({
          address: evm.usdcAddr, abi: usdcAbi,
          functionName: "approve", args: [evm.spokeAddr, 0n],
          account: operator, chain: baseSepolia,
        });
        await send("approve(0)", zeroH);
      }

      if (currentAllowance < baseAmount) {
        const approveH = await wc.writeContract({
          address: evm.usdcAddr, abi: usdcAbi,
          functionName: "approve", args: [evm.spokeAddr, baseAmount],
          account: operator, chain: baseSepolia,
        });
        await send("approve", approveH);
        logMsg(`approve ${approveH.slice(0,12)}…`);
      } else {
        logMsg(`allowance already sufficient (${currentAllowance})`);
      }

      // Sanity check: read back the allowance before depositing. The public
      // Base Sepolia RPC pool is load-balanced and reads sometimes hit a node
      // lagged by a block or two even after a write confirms — retry briefly
      // before giving up.
      let postAllowance = 0n;
      for (let attempt = 0; attempt < 10; attempt++) {
        postAllowance = (await pc.readContract({
          address: evm.usdcAddr, abi: usdcAbi, functionName: "allowance",
          args: [operator.address, evm.spokeAddr],
        })) as bigint;
        if (postAllowance >= baseAmount) break;
        await sleep(1500);
      }
      if (postAllowance < baseAmount) {
        throw new Error(
          `Allowance still insufficient after approve: ${postAllowance} < ${baseAmount}. Public RPC stuck.`,
        );
      }

      const depositH = await wc.writeContract({
        address: evm.spokeAddr, abi: spokeAbi,
        functionName: "deposit",
        args: [
          evm.ticker,
          evm.assetHash,
          baseAmount,
          ("0x" + Buffer.from(fill32("ct-ui-A")).toString("hex")) as Hex,
          1n,
        ],
        account: operator, chain: baseSepolia,
      });
      const rec = await send("deposit", depositH);
      const ev = parseEventLogs({ abi: spokeAbi, eventName: "DepositPosted", logs: rec.logs });
      const intentId = (ev[0]?.args as any)?.intentId ?? "0x";
      patch((s) => {
        s.deposits.evm = { txHash: depositH, intentId, amountRaw: baseAmount.toString() };
      });
      logMsg(`EVM deposit confirmed (tx ${depositH.slice(0,12)}…)`);
      await sleep(PAUSE_MS);
    }

    // ── Phase 1b · Deposit on Solana Devnet ──
    if (solAmount > 0n) {
      patch((s) => (s.phase = "deposit-sol"));
      logMsg(`Deposit ${solAmount} (raw) on Solana Devnet`);

      const operatorSol = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(join(STATE_DIR, "operator-sol.json"), "utf8")) as number[]),
      );
      const connection = new Connection(sol.rpc, "confirmed");
      const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(operatorSol), { commitment: "confirmed" });
      anchor.setProvider(provider);
      const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
      const program = new Program(idl, provider) as Program<any>;

      const mint = new PublicKey(sol.mint);
      const operatorAta = (
        await getOrCreateAssociatedTokenAccount(connection, operatorSol, mint, operatorSol.publicKey)
      ).address;
      const userAcct = await getAccount(connection, operatorAta);
      if (userAcct.amount < solAmount) {
        await mintTo(connection, operatorSol, mint, operatorAta, operatorSol, solAmount - userAcct.amount + 1_000_000n);
        logMsg("Topped up operator SPL mUSDC");
      }

      const tickerBytes = Array.from(Buffer.from(sol.tickerKeccak.slice(2), "hex"));
      const assetHashBytes = Array.from(fill32("solana:USDC"));
      const txSig = await program.methods
        .deposit(tickerBytes, assetHashBytes, new BN(solAmount.toString()), Array.from(fill32("ct-ui-B")), new BN(1))
        .accounts({
          user: operatorSol.publicKey,
          config: new PublicKey(sol.configPda),
          tickerBinding: new PublicKey(sol.tickerKeccakPda),
          mint,
          vault: new PublicKey(sol.vaultKeccakPda),
          userTokenAccount: operatorAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      patch((s) => {
        s.deposits.sol = { txSig, amountRaw: solAmount.toString() };
        s.users.userBSol = operatorSol.publicKey.toBase58();
      });
      logMsg(`Solana deposit confirmed (${txSig.slice(0,12)}…)`);
      await sleep(PAUSE_MS);
    }

    // ── Phase 2 · Net ──
    patch((s) => (s.phase = "net"));
    const baseToSol = baseAmount;
    const solToBase = solAmount;
    const matched = baseToSol < solToBase ? baseToSol : solToBase;
    const surplus = baseToSol > solToBase ? baseToSol - solToBase : solToBase - baseToSol;
    const direction =
      baseToSol > solToBase ? "base→solana" : solToBase > baseToSol ? "solana→base" : "flat";
    patch((s) => {
      s.net = {
        baseToSolRaw: baseToSol.toString(),
        solToBaseRaw: solToBase.toString(),
        matchedRaw: matched.toString(),
        surplusRaw: surplus.toString(),
        direction,
      };
    });
    logMsg(`Net: matched ${matched}, surplus ${surplus} ${direction}`);
    await sleep(PAUSE_MS);

    // ── Phase 3a · Ika sign probe (best-effort) ──
    patch((s) => (s.phase = "ika-sign-attempt"));
    if (dkg) {
      try {
        const probe = await ikaTrySign(sender, dkg.publicKey, fill32("probe"));
        patch((s) => (s.ika.signAttemptError = probe.ok ? null : probe.error));
        logMsg(`Ika sign probe: ${probe.ok ? "ok" : "rejected (pre-alpha)"}`);
      } catch (e: any) {
        logMsg(`Ika sign probe failed: ${e?.message ?? String(e)}`);
        patch((s) => (s.ika.signAttemptError = e?.message ?? String(e)));
      }
    } else {
      logMsg("Ika sign probe skipped (no DKG)");
    }
    await sleep(PAUSE_MS);

    // ── Phase 3b · Sign + unlock ──
    patch((s) => (s.phase = "sign"));
    logMsg("Signing both settlement orders");
    await sleep(PAUSE_MS / 2);

    const settled = await settle({
      baseToSol: baseAmount > 0n
        ? { amountRaw: baseAmount.toString(), recipientSol: userARecipientSol.publicKey.toBase58() }
        : null,
      solToBase: solAmount > 0n
        ? { amountRaw: solAmount.toString(), recipientEvm: userBRecipientEvm.address }
        : null,
    });

    patch((s) => {
      s.phase = "unlock-evm";
      if (settled.evmUnlock) {
        s.unlocks.evm = { txHash: settled.evmUnlock.txHash, amountRaw: settled.evmUnlock.amountRaw };
      }
      s.balances.userBOnEvmRaw = settled.balances.userBOnEvmRaw;
    });
    logMsg(settled.evmUnlock ? `EVM unlock confirmed (${settled.evmUnlock.txHash.slice(0,12)}…)` : "EVM leg skipped");
    await sleep(PAUSE_MS);

    patch((s) => {
      s.phase = "unlock-sol";
      if (settled.solUnlock) {
        s.unlocks.sol = { txSig: settled.solUnlock.txSig, amountRaw: settled.solUnlock.amountRaw };
      }
      s.balances.userAOnSolRaw = settled.balances.userAOnSolRaw;
      s.balances.evmVaultRaw = settled.balances.evmVaultRaw;
      s.balances.solVaultRaw = settled.balances.solVaultRaw;
    });
    logMsg(settled.solUnlock ? `SOL unlock confirmed (${settled.solUnlock.txSig.slice(0,12)}…)` : "SOL leg skipped");
    await sleep(PAUSE_MS);

    patch((s) => (s.phase = "done"));
    logMsg(`Done — net ${surplus} ${direction}`);
  } catch (e: any) {
    patch((s) => {
      s.phase = "error";
      s.errorMsg = e?.shortMessage ?? e?.message ?? String(e);
    });
    logMsg(`ERROR: ${e?.shortMessage ?? e?.message ?? String(e)}`);
    console.error("/run-demo failed:", e);
  } finally {
    state.busy = false;
  }
}

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  if (req.url === "/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state.current));
    return;
  }
  if (req.url === "/run-demo" && req.method === "POST") {
    if (state.busy) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "demo already running" }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      console.log("→ /run-demo", body);
      // Kick off async; respond immediately so the UI can start polling /state.
      runDemo(body).catch((e) => console.error("runDemo crashed:", e));
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "started" }));
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }));
    }
    return;
  }
  if (req.url === "/reset" && req.method === "POST") {
    if (state.busy) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "demo running" }));
      return;
    }
    state.current = freshState();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/settle" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      console.log("→ /settle", JSON.stringify(body));
      const result = await settle(body);
      console.log("✓ settled", result.direction, "surplus", result.surplusRaw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e: any) {
      console.error("/settle failed:", e?.shortMessage ?? e?.message ?? e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e?.shortMessage ?? e?.message ?? String(e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

const server = createServer((req, res) => { handle(req, res); });
server.listen(PORT, "127.0.0.1", () => {
  console.log(`HyperSettle settle-server listening on http://localhost:${PORT}`);
  console.log("  POST /settle  — execute settlement against deployed spokes");
  console.log("  GET  /health");
});
