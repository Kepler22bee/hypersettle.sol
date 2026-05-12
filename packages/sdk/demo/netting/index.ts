// End-to-end netting demo with live state served to the frontend.
//
// Flow:
//   0. Real Ika DKG via @ika.xyz/pre-alpha-solana-client.
//   1. Boot anvil + solana-test-validator + deploy spokes with mUSDC.
//   2. Two real deposits (101 on EVM, 100 on Solana).
//   3. Net calculation.
//   4. Sign settlement orders + submit executeSettlement on both spokes.
//   5. Final state — tokens unlocked, net rebalance shown.
//
// While running, the orchestrator serves the demo state at
// http://localhost:7070/state for the frontend at /netting to render.
// After Phase 5 the process stays alive (so the UI can keep showing the
// final state) until Ctrl-C.

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  privateKeyToAccount,
  generatePrivateKey,
} from "viem/accounts";
import { keccak256, stringToBytes, type Hex } from "viem";

import {
  evmSettlementDigest,
  type SettlementOrder,
} from "../../src/index.js";

import {
  bringUpEvm,
  evmBalance,
  evmDeposit,
  evmExecuteSettlement,
  type EvmEnv,
} from "./evm.js";
import {
  bringUpSolana,
  solanaBalance,
  solanaDeposit,
  solanaExecuteSettlement,
  solanaVaultBalance,
  HUB_CHAIN as SOL_HUB_CHAIN,
  SELF_CHAIN as SOL_SELF_CHAIN,
  SELF_DOMAIN as SOL_SELF_DOMAIN,
  type SolanaEnv,
  type SolanaSettlementOrder,
} from "./solana.js";
import { ikaDkg, ikaTrySign, IKA_BASE_URL } from "./ika.js";
import { StateServer, makeInitialState, type Phase } from "./state-server.js";

const SCALE = 1_000_000n;
const EVM_DEST_CHAIN = 10004;
const EVM_SELF_DOMAIN = 7;
const EVM_CHAIN_ID = 84532;
const PAUSE_MS = Number(process.env.HS_PAUSE_MS ?? 3000);

function fmtUsdc(raw: bigint): string {
  const whole = raw / SCALE;
  const frac = (raw % SCALE).toString().padStart(6, "0");
  return `${whole.toString()}.${frac} mUSDC`;
}

function paddedSolanaPubkey(pk: PublicKey): Uint8Array {
  return new Uint8Array(pk.toBytes());
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
function hexFromBytes(b: Uint8Array): Hex {
  return ("0x" + Buffer.from(b).toString("hex")) as Hex;
}
function box(title: string) {
  const bar = "─".repeat(Math.max(40, title.length + 4));
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let evm: EvmEnv | null = null;
  let sol: SolanaEnv | null = null;

  const state = makeInitialState(IKA_BASE_URL, EVM_CHAIN_ID);
  const server = new StateServer(state);
  await server.start();
  console.log(`▸ Live state on http://localhost:${server.port}/state`);
  console.log(`▸ UI at        http://localhost:3000/netting`);

  process.on("SIGINT", async () => {
    server.stop();
    await evm?.shutdown();
    await sol?.shutdown();
    process.exit(130);
  });

  const setPhase = (p: Phase) => server.patch((s) => (s.phase = p));

  try {
    setPhase("ika-dkg");
    box("Phase 0 · Provision dWallet via official Ika SDK");
    console.log("Calling @ika.xyz/pre-alpha-solana-client (DKG) against the live network.");
    console.log(`Endpoint: ${IKA_BASE_URL}`);
    const sender = fill32("hypersettle-netting-demo");
    const dkg = await ikaDkg(sender);
    const dkgHex = "0x" + Buffer.from(dkg.publicKey).toString("hex");
    console.log(`  ✓ DKG returned real ed25519 pubkey: ${dkgHex}`);
    console.log(`  elapsed ${dkg.elapsedMs}ms`);
    server.patch((s) => {
      s.ika.dkgPubkey = dkgHex;
      s.ika.dkgElapsedMs = dkg.elapsedMs;
    });
    server.log(`Ika DKG OK — pubkey ${dkgHex.slice(0, 12)}…${dkgHex.slice(-6)}`);
    await sleep(PAUSE_MS);

    setPhase("boot");
    box("Bringing up local sandboxes");
    console.log("• anvil (chain id 84532, port 8545)");
    console.log("• solana-test-validator (rpc 8899)");

    [evm, sol] = await Promise.all([
      bringUpEvm(),
      bringUpSolana({ ikaDkgPubkey: dkg.publicKey }),
    ]);

    console.log(`✓ EVM spoke   ${evm.spokeAddr}`);
    console.log(`  EVM mUSDC   ${evm.usdcAddr}`);
    console.log(`  Ika ECDSA   ${evm.ikaAddress}  (local key — no published Ika ECDSA pre-alpha SDK)`);
    console.log(`✓ SOL spoke   ${sol.program.programId.toBase58()}`);
    console.log(`  SOL mUSDC   ${sol.mint.toBase58()}`);
    console.log(`  Ika DKG     ${sol.ikaDkgPubkey?.toBase58() ?? "—"}  (real, from Ika network)`);
    console.log(`  Spoke uses  ${sol.signingPubkey.toBase58()}  (local stand-in for unlock)`);

    const userARecipientSol = Keypair.generate();
    const userBRecipientEvm = privateKeyToAccount(generatePrivateKey());

    server.patch((s) => {
      s.env.evm.spokeAddr = evm!.spokeAddr;
      s.env.evm.usdcAddr = evm!.usdcAddr;
      s.env.evm.ikaAddress = evm!.ikaAddress;
      s.env.sol.spokeProgram = sol!.program.programId.toBase58();
      s.env.sol.mint = sol!.mint.toBase58();
      s.env.sol.signingPubkey = sol!.signingPubkey.toBase58();
      s.env.sol.ikaDkgPubkey = sol!.ikaDkgPubkey?.toBase58() ?? null;
      s.users.userAEvm = evm!.userA.address;
      s.users.userASolRecipient = userARecipientSol.publicKey.toBase58();
      s.users.userBSol = sol!.userB.publicKey.toBase58();
      s.users.userBEvmRecipient = userBRecipientEvm.address;
    });
    server.log("Sandboxes up; spokes deployed with mUSDC vault liquidity");
    await sleep(PAUSE_MS);

    setPhase("deposit-evm");
    box("Phase 1 · Two deposits, opposite directions");
    const epoch = 1n;
    console.log(
      `• User A deposits 101 mUSDC on EVM spoke → wants payout on Solana to ${userARecipientSol.publicKey.toBase58()}`,
    );
    const evmDep = await evmDeposit(
      evm,
      101n * SCALE,
      keccak256(stringToBytes("ct-userA-101")),
      epoch,
    );
    console.log(`  ✓ deposit tx: ${evmDep.txHash}`);
    console.log(`    intent id : ${evmDep.intentId}`);
    server.patch((s) => {
      s.deposits.evm = {
        txHash: evmDep.txHash,
        intentId: evmDep.intentId,
        amountRaw: (101n * SCALE).toString(),
      };
    });
    server.log(`EVM deposit confirmed (101 mUSDC)`);
    await sleep(PAUSE_MS);

    setPhase("deposit-sol");
    console.log(
      `• User B deposits 100 mUSDC on Solana spoke → wants payout on EVM to ${userBRecipientEvm.address}`,
    );
    const solDep = await solanaDeposit(
      sol,
      100n * SCALE,
      Array.from(fill32("ct-userB-100")),
      epoch,
    );
    console.log(`  ✓ deposit tx: ${solDep.txSig}`);
    server.patch((s) => {
      s.deposits.sol = {
        txSig: solDep.txSig,
        amountRaw: (100n * SCALE).toString(),
      };
    });
    server.log(`Solana deposit confirmed (100 mUSDC)`);
    await sleep(PAUSE_MS);

    setPhase("net");
    box("Phase 2 · Net calculation");
    const baseToSol = 101n * SCALE;
    const solToBase = 100n * SCALE;
    const matched = baseToSol < solToBase ? baseToSol : solToBase;
    const surplus = baseToSol > solToBase ? baseToSol - solToBase : solToBase - baseToSol;
    const direction = (baseToSol > solToBase
      ? "base→solana"
      : solToBase > baseToSol
      ? "solana→base"
      : "flat") as "base→solana" | "solana→base" | "flat";

    console.log(`  base→solana intent : ${fmtUsdc(baseToSol)}`);
    console.log(`  solana→base intent : ${fmtUsdc(solToBase)}`);
    console.log(`  matched (cancels)  : ${fmtUsdc(matched)}`);
    console.log(`  surplus (rebalance): ${fmtUsdc(surplus)}  direction = ${direction}`);
    server.patch((s) => {
      s.net = {
        baseToSolRaw: baseToSol.toString(),
        solToBaseRaw: solToBase.toString(),
        matchedRaw: matched.toString(),
        surplusRaw: surplus.toString(),
        direction,
      };
    });
    server.log(`Netted: matched=${fmtUsdc(matched)}, surplus=${fmtUsdc(surplus)} ${direction}`);
    await sleep(PAUSE_MS);

    setPhase("ika-sign-attempt");
    box("Phase 3a · Attempt the Solana settlement signature via the Ika SDK");
    const ikaProbeMsg = fill32("settlement-probe");
    const ikaAttempt = await ikaTrySign(sender, dkg.publicKey, ikaProbeMsg);
    if (ikaAttempt.ok && ikaAttempt.signature) {
      const isZero = ikaAttempt.signature.every((b) => b === 0);
      console.log(
        `  Ika sign returned ${ikaAttempt.signature.length} bytes${
          isZero ? " (all zeros — mock signer)" : " (non-zero!)"
        }`,
      );
    } else {
      console.log(`  Ika sign rejected: ${ikaAttempt.error}`);
      console.log(`  (Pre-alpha gap: SDK v0.1.1 doesn't thread DKG attestation into requestSign.)`);
      server.patch((s) => (s.ika.signAttemptError = ikaAttempt.error));
      server.log(`Ika sign rejected (pre-alpha): ${ikaAttempt.error?.slice(0, 80)}`);
    }
    console.log(`  ⇒ unlock will use the local stand-in registered as the Solana spoke's ikaDwallet.`);
    await sleep(PAUSE_MS);

    setPhase("sign");
    box("Phase 3b · Sign two SettlementOrders for the actual unlock");

    const evmOrder: SettlementOrder = {
      version: 1,
      sourceChain: SOL_HUB_CHAIN,
      destChain: EVM_DEST_CHAIN,
      destDomain: EVM_SELF_DOMAIN,
      ticker: new Uint8Array(
        Buffer.from(keccak256(stringToBytes("USDC")).slice(2), "hex"),
      ),
      assetHash: new Uint8Array(
        Buffer.from(keccak256(stringToBytes("base:USDC")).slice(2), "hex"),
      ),
      amount: matched,
      recipient: paddedEvmAddr(userBRecipientEvm.address),
      intentId: fill32("net-evm-leg"),
      nonce: 1n,
    };
    const evmDigest = evmSettlementDigest(evmOrder);
    const evmSigHex = await privateKeyToAccount(evm.ikaKey).sign({
      hash: ("0x" + Buffer.from(evmDigest).toString("hex")) as Hex,
    });
    const evmDigestHex = "0x" + Buffer.from(evmDigest).toString("hex");
    console.log(`  ECDSA signature : ${evmSigHex.slice(0, 14)}…${evmSigHex.slice(-8)}`);
    console.log(`  digest          : ${evmDigestHex}`);
    server.patch((s) => {
      s.signatures.evmDigest = evmDigestHex;
      s.signatures.evmSig = evmSigHex;
    });

    const solOrder: SolanaSettlementOrder = {
      version: 1,
      sourceChain: EVM_DEST_CHAIN,
      destChain: SOL_SELF_CHAIN,
      destDomain: SOL_SELF_DOMAIN,
      ticker: sol.ticker,
      assetHash: sol.assetHash,
      amount: matched + surplus,
      recipient: Array.from(paddedSolanaPubkey(userARecipientSol.publicKey)),
      intentId: Array.from(fill32("net-sol-leg")),
      nonce: 2n,
    };
    console.log(`  ed25519 signature : signed locally inside solanaExecuteSettlement`);
    server.log("Signed both settlement orders");
    await sleep(PAUSE_MS);

    setPhase("unlock-evm");
    box("Phase 4 · Unlock — submit executeSettlement on each spoke");

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
    const evmSettleTx = await evmExecuteSettlement(evm, evmOrderForAbi, evmSigHex);
    console.log(`  ✓ EVM unlock tx     : ${evmSettleTx}`);
    const evmEndUserB = await evmBalance(evm, userBRecipientEvm.address);
    console.log(`    user B EVM balance: 0 → ${fmtUsdc(evmEndUserB)}`);
    server.patch((s) => {
      s.unlocks.evm = {
        txHash: evmSettleTx,
        amountRaw: matched.toString(),
      };
      s.balances.userBOnEvmRaw = evmEndUserB.toString();
    });
    server.log(`EVM unlock: user B received ${fmtUsdc(evmEndUserB)}`);
    await sleep(PAUSE_MS);

    setPhase("unlock-sol");
    const solSettleSig = await solanaExecuteSettlement(
      sol,
      solOrder,
      userARecipientSol.publicKey,
    );
    console.log(`  ✓ Solana unlock tx  : ${solSettleSig}`);
    const solUserAEnd = await solanaBalance(sol, userARecipientSol.publicKey);
    console.log(`    user A SOL balance: 0 → ${fmtUsdc(solUserAEnd)}`);
    const evmSpokeBal = await evmBalance(evm, evm.spokeAddr);
    const solVaultEnd = await solanaVaultBalance(sol);
    server.patch((s) => {
      s.unlocks.sol = {
        txSig: solSettleSig,
        amountRaw: (matched + surplus).toString(),
      };
      s.balances.userAOnSolRaw = solUserAEnd.toString();
      s.balances.evmVaultRaw = evmSpokeBal.toString();
      s.balances.solVaultRaw = solVaultEnd.toString();
    });
    server.log(`Solana unlock: user A received ${fmtUsdc(solUserAEnd)}`);
    await sleep(PAUSE_MS);

    setPhase("done");
    box("Phase 5 · Final state + net rebalance owed");
    console.log(`  user A     receives ${fmtUsdc(solUserAEnd)} on Solana ✓`);
    console.log(`  user B     receives ${fmtUsdc(evmEndUserB)} on EVM    ✓`);
    console.log("");
    console.log(`  EVM  spoke vault   ${fmtUsdc(evmSpokeBal)}   (started 1101 → ends 1001 → +1 surplus)`);
    console.log(`  SOL  spoke vault   ${fmtUsdc(solVaultEnd)}   (started 1100 → ends  999 → -1 deficit)`);
    console.log("");
    console.log(`  Net unlock        ${fmtUsdc(surplus)} owes from ${direction.replace(/→/, " → ")}`);
    server.log(`Done — net ${fmtUsdc(surplus)} ${direction}`);

    console.log("\n▸ Demo complete. State remains live at /netting. Ctrl-C to shut down.");
    // Keep alive so the UI can keep showing the final state.
    await new Promise(() => {});
  } catch (e) {
    server.log(`ERROR: ${(e as Error)?.message ?? String(e)}`);
    throw e;
  } finally {
    await evm?.shutdown();
    await sol?.shutdown();
    server.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
