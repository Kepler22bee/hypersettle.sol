// Re-attempt bindTicker on the deployed Base Sepolia spoke.
// The initial deploy's bindTicker tx reverted silently (deploy script
// didn't check receipt status); this script retries and inspects the
// receipt explicitly.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const REPO_ROOT = join(__dirname, "../../../..");
const STATE_DIR = join(REPO_ROOT, ".netting-testnet");
const FORGE_OUT = join(REPO_ROOT, "packages/evm-spoke/out");

function loadAbi(name: string): any {
  return JSON.parse(readFileSync(join(FORGE_OUT, `${name}.sol`, `${name}.json`), "utf8")).abi;
}

async function main() {
  const evm = JSON.parse(readFileSync(join(STATE_DIR, "evm.json"), "utf8"));
  const opKey = JSON.parse(readFileSync(join(STATE_DIR, "operator-evm.json"), "utf8"));
  const operator = privateKeyToAccount(opKey.privateKey as Hex);

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(evm.rpc) });
  const wallet = createWalletClient({ account: operator, chain: baseSepolia, transport: http(evm.rpc) });

  const spokeAbi = loadAbi("HyperSettleSpoke");

  // 1) Owner sanity check
  const owner = await publicClient.readContract({
    address: evm.spokeAddr,
    abi: spokeAbi,
    functionName: "owner",
  });
  console.log("spoke.owner():", owner);
  console.log("operator     :", operator.address);

  // 2) Current binding
  const bound = await publicClient.readContract({
    address: evm.spokeAddr,
    abi: spokeAbi,
    functionName: "tickerToken",
    args: [evm.ticker],
  });
  console.log("ticker bound :", bound);

  // 3) Try simulating bindTicker first to surface the real revert
  try {
    await publicClient.simulateContract({
      address: evm.spokeAddr,
      abi: spokeAbi,
      functionName: "bindTicker",
      args: [evm.ticker, evm.usdcAddr],
      account: operator,
    });
    console.log("simulate     : ok");
  } catch (e: any) {
    console.log("simulate err :", e?.shortMessage ?? e?.message);
    if (e?.cause?.data) {
      try {
        const decoded = decodeErrorResult({ abi: spokeAbi, data: e.cause.data });
        console.log("decoded      :", decoded.errorName, decoded.args);
      } catch {}
    }
  }

  // 4) Send for real
  const hash = await wallet.writeContract({
    address: evm.spokeAddr,
    abi: spokeAbi,
    functionName: "bindTicker",
    args: [evm.ticker, evm.usdcAddr],
    account: operator,
    chain: baseSepolia,
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  console.log("bindTicker tx:", hash);
  console.log("status       :", r.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
