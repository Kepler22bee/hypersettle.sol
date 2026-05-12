"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, keccak256, toBytes, type Hex } from "viem";

const FUNDED_INTENTS_KEY = "hypersettle:funded-intents";
const NET_TRANSACTION_KEY = "hypersettle:last-net-transaction";

type NetworkKey = "baseSepolia" | "arbitrumSepolia" | "solanaDevnet";

type StoredFundedIntent = {
  ticker: string;
  amount: string;
  amountRaw: string;
  sourceNetworkKey: NetworkKey;
  sourceNetworkLabel: string;
  sourceChain: string;
  destinationNetworkKey: NetworkKey;
  destinationNetworkLabel: string;
  destinationChain: string;
  destinationDomain: string;
  destinationAssetHash: Hex;
  recipient: string;
  amountCt: Hex;
  intentId: Hex;
  depositTx: string;
  createdAt: string;
};

type NetTransaction = {
  batchId: Hex;
  totalSolToBaseRaw: string;
  totalBaseToSolRaw: string;
  matchedRaw: string;
  netRaw: string;
  direction: "solana-to-base" | "base-to-solana" | "flat";
  sourceVault: string;
  destinationVault: string;
  intentIds: Hex[];
  createdAt: string;
};

const SOLANA_USDC_VAULT = "6Mx6vDnDSbew3AwTJfhvfyLKqPHKVRkjv1iEi9DJHN78";
const BASE_SPOKE =
  process.env.NEXT_PUBLIC_BASE_SEPOLIA_SPOKE_ADDRESS ??
  process.env.NEXT_PUBLIC_EVM_SPOKE_ADDRESS ??
  "0xaF326448557F87875A9499A8C9bD3A45EAb9087E";

function loadStoredIntents(): StoredFundedIntent[] {
  try {
    const raw = window.localStorage.getItem(FUNDED_INTENTS_KEY);
    return raw ? JSON.parse(raw) as StoredFundedIntent[] : [];
  } catch {
    return [];
  }
}

function formatUsdc(raw: bigint): string {
  return `${formatUnits(raw, 6)} USDC`;
}

function directionLabel(direction: NetTransaction["direction"]): string {
  if (direction === "solana-to-base") return "Solana -> Base";
  if (direction === "base-to-solana") return "Base -> Solana";
  return "No rebalance";
}

export function SettlementCard() {
  const [intents, setIntents] = useState<StoredFundedIntent[]>([]);
  const [produced, setProduced] = useState<NetTransaction | null>(null);

  useEffect(() => {
    setIntents(loadStoredIntents());
    try {
      const raw = window.localStorage.getItem(NET_TRANSACTION_KEY);
      setProduced(raw ? JSON.parse(raw) as NetTransaction : null);
    } catch {
      setProduced(null);
    }
  }, []);

  const relevantIntents = useMemo(
    () => intents.filter((intent) =>
      (intent.sourceNetworkKey === "solanaDevnet" && intent.destinationNetworkKey === "baseSepolia") ||
      (intent.sourceNetworkKey === "baseSepolia" && intent.destinationNetworkKey === "solanaDevnet")
    ),
    [intents],
  );

  const totals = useMemo(() => {
    let solToBase = 0n;
    let baseToSol = 0n;
    for (const intent of relevantIntents) {
      const amount = BigInt(intent.amountRaw || "0");
      if (intent.sourceNetworkKey === "solanaDevnet") solToBase += amount;
      if (intent.sourceNetworkKey === "baseSepolia") baseToSol += amount;
    }
    const matched = solToBase < baseToSol ? solToBase : baseToSol;
    const net = solToBase > baseToSol ? solToBase - baseToSol : baseToSol - solToBase;
    const direction: NetTransaction["direction"] =
      solToBase > baseToSol ? "solana-to-base" :
      baseToSol > solToBase ? "base-to-solana" :
      "flat";
    return { solToBase, baseToSol, matched, net, direction };
  }, [relevantIntents]);

  function produceNetTransaction() {
    const sourceVault =
      totals.direction === "solana-to-base" ? SOLANA_USDC_VAULT :
      totals.direction === "base-to-solana" ? BASE_SPOKE :
      "-";
    const destinationVault =
      totals.direction === "solana-to-base" ? BASE_SPOKE :
      totals.direction === "base-to-solana" ? SOLANA_USDC_VAULT :
      "-";
    const intentIds = relevantIntents.map((intent) => intent.intentId);
    const batchSeed = JSON.stringify({
      intentIds,
      solToBase: totals.solToBase.toString(),
      baseToSol: totals.baseToSol.toString(),
      net: totals.net.toString(),
      direction: totals.direction,
    });
    const tx: NetTransaction = {
      batchId: keccak256(toBytes(batchSeed)),
      totalSolToBaseRaw: totals.solToBase.toString(),
      totalBaseToSolRaw: totals.baseToSol.toString(),
      matchedRaw: totals.matched.toString(),
      netRaw: totals.net.toString(),
      direction: totals.direction,
      sourceVault,
      destinationVault,
      intentIds,
      createdAt: new Date().toISOString(),
    };
    window.localStorage.setItem(NET_TRANSACTION_KEY, JSON.stringify(tx));
    setProduced(tx);
  }

  function clearBatch() {
    window.localStorage.removeItem(FUNDED_INTENTS_KEY);
    window.localStorage.removeItem(NET_TRANSACTION_KEY);
    setIntents([]);
    setProduced(null);
    setSettleResult(null);
    setSettleError(null);
  }

  const SETTLE_SERVER =
    process.env.NEXT_PUBLIC_SETTLE_SERVER_URL ?? "http://localhost:7071";

  const [settleBusy, setSettleBusy] = useState(false);
  const [settleResult, setSettleResult] = useState<any>(null);
  const [settleError, setSettleError] = useState<string | null>(null);

  // Pick one intent per direction (the most recent) to settle. Real product
  // would aggregate; for this demo a single matched pair is enough.
  const baseToSolIntent = relevantIntents
    .filter((i) => i.sourceNetworkKey === "baseSepolia" && i.destinationNetworkKey === "solanaDevnet")
    .at(-1);
  const solToBaseIntent = relevantIntents
    .filter((i) => i.sourceNetworkKey === "solanaDevnet" && i.destinationNetworkKey === "baseSepolia")
    .at(-1);

  async function unlockOnChain() {
    setSettleBusy(true);
    setSettleError(null);
    setSettleResult(null);
    try {
      const body = {
        baseToSol: baseToSolIntent
          ? {
              amountRaw: baseToSolIntent.amountRaw,
              recipientSol: baseToSolIntent.recipient,
            }
          : null,
        solToBase: solToBaseIntent
          ? {
              amountRaw: solToBaseIntent.amountRaw,
              recipientEvm: solToBaseIntent.recipient,
            }
          : null,
      };
      const r = await fetch(`${SETTLE_SERVER}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setSettleResult(data);
    } catch (e: any) {
      setSettleError(e?.message ?? String(e));
    } finally {
      setSettleBusy(false);
    }
  }

  return (
    <div>
      <section className="page-title">
        <div>
          <div className="eyebrow">Operator action</div>
          <h2>Net and settle intents</h2>
          <p>
            Match Solana to Base against Base to Solana. Users are paid from
            destination vaults, while the system creates only one net rebalance
            transaction for the difference.
          </p>
        </div>
        <span className="status-pill">{relevantIntents.length} nettable intents</span>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>Batch totals</h2>
              <p>Opposite directions cancel each other before any cross-chain movement.</p>
            </div>
          </div>

          {relevantIntents.length < 2 && (
            <div className="notice">
              <strong>Need both sides:</strong> create one Solana {"->"} Base Fund Intent
              and one Base {"->"} Solana Fund Intent to see netting.
            </div>
          )}

          <div className="kv">
            <div className="k">Solana {"->"} Base</div><div>{formatUsdc(totals.solToBase)}</div>
            <div className="k">Base {"->"} Solana</div><div>{formatUsdc(totals.baseToSol)}</div>
            <div className="k">matched</div><div>{formatUsdc(totals.matched)}</div>
            <div className="k">net</div><div>{formatUsdc(totals.net)}</div>
            <div className="k">direction</div><div>{directionLabel(totals.direction)}</div>
          </div>

          <div className="actions">
            <button
              className="cta"
              onClick={unlockOnChain}
              disabled={settleBusy || (!baseToSolIntent && !solToBaseIntent)}
              style={{ width: "auto", padding: "12px 22px", marginTop: 0 }}
            >
              {settleBusy
                ? "Unlocking on-chain…"
                : settleResult
                ? "Unlock another batch"
                : "Unlock settlement on-chain"}
            </button>
            <button className="secondary" onClick={produceNetTransaction} disabled={relevantIntents.length === 0}>
              Preview receipt (no tx)
            </button>
            <button className="secondary" onClick={() => setIntents(loadStoredIntents())}>
              Reload batch
            </button>
            <button className="secondary" onClick={clearBatch}>
              Clear batch
            </button>
          </div>

          {settleError && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)", marginTop: 14 }}>
              <strong className="err">Settle failed</strong>
              <div className="code" style={{ marginTop: 6 }}>
                <span className="err">{settleError}</span>
              </div>
              <div className="tag" style={{ marginTop: 8 }}>
                Is <span className="mono">pnpm settle-server</span> running on
                {" "}<span className="mono">{SETTLE_SERVER}</span>?
              </div>
            </div>
          )}

          {settleResult && (
            <div className="notice" style={{ borderLeftColor: "var(--good)", marginTop: 14 }}>
              <strong className="ok">✓ On-chain unlock complete</strong>
              <div className="kv" style={{ marginTop: 10 }}>
                <div className="k">direction</div><div>{settleResult.direction}</div>
                <div className="k">matched</div><div>{formatUsdc(BigInt(settleResult.matchedRaw))}</div>
                <div className="k">surplus</div><div>{formatUsdc(BigInt(settleResult.surplusRaw))}</div>
                {settleResult.evmUnlock && (
                  <>
                    <div className="k">EVM unlock</div>
                    <div>
                      <a href={settleResult.evmUnlock.explorer} target="_blank" rel="noreferrer">
                        basescan ↗
                      </a>
                      {" · "}{formatUsdc(BigInt(settleResult.evmUnlock.amountRaw))} to{" "}
                      <span className="mono">{settleResult.evmUnlock.recipient.slice(0,10)}…</span>
                    </div>
                  </>
                )}
                {settleResult.solUnlock && (
                  <>
                    <div className="k">SOL unlock</div>
                    <div>
                      <a href={settleResult.solUnlock.explorer} target="_blank" rel="noreferrer">
                        explorer ↗
                      </a>
                      {" · "}{formatUsdc(BigInt(settleResult.solUnlock.amountRaw))} to{" "}
                      <span className="mono">{settleResult.solUnlock.recipient.slice(0,10)}…</span>
                    </div>
                  </>
                )}
                <div className="k">EVM vault</div>
                <div>{formatUsdc(BigInt(settleResult.balances.evmVaultRaw))}</div>
                <div className="k">SOL vault</div>
                <div>{formatUsdc(BigInt(settleResult.balances.solVaultRaw))}</div>
              </div>
            </div>
          )}

          <h2 style={{ marginTop: 20 }}>Funded intents</h2>
          <div className="intent-list">
            {relevantIntents.map((intent) => (
              <div className="intent-row" key={`${intent.intentId}-${intent.depositTx}`}>
                <div>
                  <strong>{intent.sourceNetworkLabel} {"->"} {intent.destinationNetworkLabel}</strong>
                  <p>{formatUsdc(BigInt(intent.amountRaw || "0"))} to {intent.recipient}</p>
                </div>
                <span>{intent.depositTx.slice(0, 10)}...</span>
              </div>
            ))}
            {relevantIntents.length === 0 && (
              <div className="notice">No Solana/Base funded intents in this browser batch.</div>
            )}
          </div>
        </section>

        <aside className="panel preview">
          <h2>Net transaction</h2>
          <div className="kv">
            <div className="k">batch</div><div>{produced?.batchId ?? "-"}</div>
            <div className="k">direction</div><div>{produced ? directionLabel(produced.direction) : "-"}</div>
            <div className="k">amount</div><div>{produced ? formatUsdc(BigInt(produced.netRaw)) : "-"}</div>
            <div className="k">source vault</div><div>{produced?.sourceVault ?? "-"}</div>
            <div className="k">dest vault</div><div>{produced?.destinationVault ?? "-"}</div>
            <div className="k">intents</div><div>{produced?.intentIds.length ?? 0}</div>
          </div>

          <label style={{ marginTop: 12 }}>Transaction payload</label>
          <div className="code">
            {produced
              ? JSON.stringify(produced, null, 2)
              : "Click Produce net transaction after funding both directions."}
          </div>
        </aside>
      </div>
    </div>
  );
}
