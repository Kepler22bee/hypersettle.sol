// EVM-side bring-up for the netting demo.
//
// Boots an anvil instance at chain id 84532 (so the spoke's
// _wormholeChainFromEvmChainId() returns 10004 — Base Sepolia), deploys
// MockUSDC + MockWormhole + HyperSettleSpoke, binds the USDC ticker, and
// funds user A and the spoke vault with mUSDC liquidity.
//
// Returns the live viem clients, contract addresses, accounts, and the
// secp256k1 Ika dWallet key the orchestrator will use to sign EVM-bound
// SettlementOrders.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";

const REPO_ROOT = join(__dirname, "../../../..");
const FORGE_OUT = join(REPO_ROOT, "packages/evm-spoke/out");
const ANVIL_PORT = 8545;
const CHAIN_ID = 84532; // Base Sepolia → wormhole chain 10004
const SELF_DOMAIN = 7;
const HUB_CHAIN_SOLANA = 1;

// Anvil's first deterministic account.
const DEPLOYER_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_A_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1

const localChain = {
  ...foundry,
  id: CHAIN_ID,
  rpcUrls: {
    default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] },
  },
} as const;

function loadArtifact(name: string): { abi: any; bytecode: Hex } {
  const path = join(FORGE_OUT, `${name}.sol`, `${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const bytecode = json.bytecode?.object as Hex;
  if (!bytecode || !bytecode.startsWith("0x")) {
    throw new Error(`forge artifact missing bytecode: ${name}`);
  }
  return { abi: json.abi, bytecode };
}

export interface EvmEnv {
  process: ChildProcessWithoutNullStreams;
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: ReturnType<typeof privateKeyToAccount>;
  userA: ReturnType<typeof privateKeyToAccount>;
  ikaKey: Hex;
  ikaAddress: Address;
  spokeAddr: Address;
  usdcAddr: Address;
  wormholeAddr: Address;
  spokeAbi: any;
  usdcAbi: any;
  ticker: Hex;
  assetHash: Hex;
  shutdown: () => Promise<void>;
}

async function startAnvil(): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    "anvil",
    [
      "--port",
      String(ANVIL_PORT),
      "--chain-id",
      String(CHAIN_ID),
      "--silent",
      "--block-time",
      "1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("anvil failed to start within 5s"));
    }, 5000);
    child.unref();
    const probe = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${ANVIL_PORT}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        if (r.ok) {
          clearTimeout(t);
          clearInterval(probe);
          resolve();
        }
      } catch {}
    }, 100);
  });

  return child;
}

export async function bringUpEvm(): Promise<EvmEnv> {
  const proc = await startAnvil();

  const publicClient = createPublicClient({
    chain: localChain,
    transport: http(),
  }) as PublicClient;

  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const userA = privateKeyToAccount(USER_A_KEY);

  const walletClient = createWalletClient({
    account: deployer,
    chain: localChain,
    transport: http(),
  });

  const usdcArtifact = loadArtifact("MockUSDC");
  const wormholeArtifact = loadArtifact("MockWormhole");
  const spokeArtifact = loadArtifact("HyperSettleSpoke");

  const usdcHash = await walletClient.deployContract({
    abi: usdcArtifact.abi,
    bytecode: usdcArtifact.bytecode,
    account: deployer,
    chain: localChain,
  });
  const usdcReceipt = await publicClient.waitForTransactionReceipt({ hash: usdcHash });
  const usdcAddr = usdcReceipt.contractAddress!;

  const wormholeHash = await walletClient.deployContract({
    abi: wormholeArtifact.abi,
    bytecode: wormholeArtifact.bytecode,
    account: deployer,
    chain: localChain,
  });
  const wormholeReceipt = await publicClient.waitForTransactionReceipt({
    hash: wormholeHash,
  });
  const wormholeAddr = wormholeReceipt.contractAddress!;

  const ikaKey = generatePrivateKey();
  const ikaAccount = privateKeyToAccount(ikaKey);

  const spokeHash = await walletClient.deployContract({
    abi: spokeArtifact.abi,
    bytecode: spokeArtifact.bytecode,
    args: [
      deployer.address,
      HUB_CHAIN_SOLANA,
      SELF_DOMAIN,
      wormholeAddr,
      ikaAccount.address,
    ],
    account: deployer,
    chain: localChain,
  });
  const spokeReceipt = await publicClient.waitForTransactionReceipt({ hash: spokeHash });
  const spokeAddr = spokeReceipt.contractAddress!;

  const ticker = keccak256(stringToBytes("USDC"));
  const assetHash = keccak256(stringToBytes("base:USDC"));

  await walletClient.writeContract({
    address: spokeAddr,
    abi: spokeArtifact.abi,
    functionName: "bindTicker",
    args: [ticker, usdcAddr],
    account: deployer,
    chain: localChain,
  });

  // Mint mUSDC: user A gets 500, spoke vault gets 1000 in liquidity to cover
  // the 100 USDC payout to user B (the matched leg).
  const SCALE = 1_000_000n; // 6 decimals
  await walletClient.writeContract({
    address: usdcAddr,
    abi: usdcArtifact.abi,
    functionName: "mint",
    args: [userA.address, 500n * SCALE],
    account: deployer,
    chain: localChain,
  });
  await walletClient.writeContract({
    address: usdcAddr,
    abi: usdcArtifact.abi,
    functionName: "mint",
    args: [spokeAddr, 1000n * SCALE],
    account: deployer,
    chain: localChain,
  });

  return {
    process: proc,
    publicClient,
    walletClient,
    deployer,
    userA,
    ikaKey,
    ikaAddress: ikaAccount.address,
    spokeAddr,
    usdcAddr,
    wormholeAddr,
    spokeAbi: spokeArtifact.abi,
    usdcAbi: usdcArtifact.abi,
    ticker,
    assetHash,
    shutdown: async () => {
      proc.kill("SIGKILL");
    },
  };
}

export async function evmDeposit(
  env: EvmEnv,
  amountRaw: bigint,
  ctHandle: Hex,
  epoch: bigint,
): Promise<{ intentId: Hex; txHash: Hex }> {
  const userClient = createWalletClient({
    account: env.userA,
    chain: localChain,
    transport: http(),
  });

  await userClient.writeContract({
    address: env.usdcAddr,
    abi: env.usdcAbi,
    functionName: "approve",
    args: [env.spokeAddr, amountRaw],
    account: env.userA,
    chain: localChain,
  });

  const txHash = await userClient.writeContract({
    address: env.spokeAddr,
    abi: env.spokeAbi,
    functionName: "deposit",
    args: [env.ticker, env.assetHash, amountRaw, ctHandle, epoch],
    account: env.userA,
    chain: localChain,
  });
  const receipt = await env.publicClient.waitForTransactionReceipt({ hash: txHash });
  const events = parseEventLogs({
    abi: env.spokeAbi,
    eventName: "DepositPosted",
    logs: receipt.logs,
  });
  const intentId = (events[0]?.args as any)?.intentId as Hex;
  return { intentId, txHash };
}

export async function evmBalance(env: EvmEnv, addr: Address): Promise<bigint> {
  return (await env.publicClient.readContract({
    address: env.usdcAddr,
    abi: env.usdcAbi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
}

export async function evmExecuteSettlement(
  env: EvmEnv,
  order: any, // SettlementOrder ABI struct
  signature: Hex,
): Promise<Hex> {
  const txHash = await env.walletClient.writeContract({
    address: env.spokeAddr,
    abi: env.spokeAbi,
    functionName: "executeSettlement",
    args: [order, signature],
    account: env.deployer,
    chain: localChain,
  });
  await env.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}
