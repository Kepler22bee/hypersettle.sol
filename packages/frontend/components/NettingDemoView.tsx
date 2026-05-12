"use client";

import { useEffect, useState } from "react";

const SERVER_BASE =
  process.env.NEXT_PUBLIC_SETTLE_SERVER_URL ?? "http://localhost:7071";
const STATE_URL = `${SERVER_BASE}/state`;
const RUN_URL = `${SERVER_BASE}/run-demo`;
const RESET_URL = `${SERVER_BASE}/reset`;

type Phase =
  | "init"
  | "ika-dkg"
  | "boot"
  | "deposit-evm"
  | "deposit-sol"
  | "net"
  | "ika-sign-attempt"
  | "sign"
  | "unlock-evm"
  | "unlock-sol"
  | "done"
  | "error";

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
    evm: {
      spokeAddr: string | null;
      usdcAddr: string | null;
      ikaAddress: string | null;
      chainId: number;
    };
    sol: {
      spokeProgram: string | null;
      mint: string | null;
      signingPubkey: string | null;
      ikaDkgPubkey: string | null;
    };
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
  net: {
    baseToSolRaw: string;
    solToBaseRaw: string;
    matchedRaw: string;
    surplusRaw: string;
    direction: string;
  } | null;
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
}

const PHASES: { key: Phase; label: string }[] = [
  { key: "ika-dkg", label: "Ika DKG" },
  { key: "boot", label: "Deploy spokes" },
  { key: "deposit-evm", label: "Deposit EVM" },
  { key: "deposit-sol", label: "Deposit Solana" },
  { key: "net", label: "Net" },
  { key: "ika-sign-attempt", label: "Ika sign" },
  { key: "sign", label: "Sign orders" },
  { key: "unlock-evm", label: "Unlock EVM" },
  { key: "unlock-sol", label: "Unlock Solana" },
  { key: "done", label: "Done" },
];

function fmtUsdc(raw: string | null): string {
  if (!raw) return "—";
  try {
    const n = BigInt(raw);
    const whole = n / 1_000_000n;
    const frac = (n % 1_000_000n).toString().padStart(6, "0");
    return `${whole.toString()}.${frac}`;
  } catch {
    return raw;
  }
}

function short(s: string | null, head = 8, tail = 6): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function HexChip({ value }: { value: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="tag">—</span>;
  return (
    <span className="hex-chip" title={value}>
      <span>{short(value, 10, 6)}</span>
      <button
        className="hex-chip-btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {}
        }}
      >
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}

function PhaseStrip({ phase }: { phase: Phase }) {
  const idx = PHASES.findIndex((p) => p.key === phase);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${PHASES.length}, 1fr)`,
        gap: 6,
        marginBottom: 18,
      }}
    >
      {PHASES.map((p, i) => {
        const done = i < idx || phase === "done";
        const active = i === idx && phase !== "done";
        return (
          <div
            key={p.key}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid",
              background: active ? "var(--accent-soft)" : "var(--panel-3)",
              borderColor: active ? "var(--accent)" : "var(--border)",
              opacity: done || active ? 1 : 0.5,
              fontSize: 11,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                background: done ? "var(--good)" : active ? "var(--accent)" : "var(--panel-2)",
                color: done || active ? "white" : "var(--muted)",
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            <span
              style={{
                color: active || done ? "var(--text)" : "var(--muted)",
                textAlign: "center",
              }}
            >
              {p.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function NettingDemoView() {
  const [state, setState] = useState<DemoState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseAmount, setBaseAmount] = useState("1.01");
  const [solAmount, setSolAmount] = useState("1.00");
  const [runError, setRunError] = useState<string | null>(null);

  const isRunning = !!state && !["init", "done", "error"].includes(state.phase);
  const isDone = state?.phase === "done";

  function toRaw(s: string): bigint {
    if (!/^\d*\.?\d*$/.test(s) || s === "") return 0n;
    const [whole, frac = ""] = s.split(".");
    const fracPadded = (frac + "000000").slice(0, 6);
    return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0");
  }

  async function runDemo() {
    setRunError(null);
    try {
      const r = await fetch(RUN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseAmountRaw: toRaw(baseAmount).toString(),
          solAmountRaw: toRaw(solAmount).toString(),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    } catch (e: any) {
      setRunError(e?.message ?? String(e));
    }
  }

  async function resetState() {
    setRunError(null);
    try {
      await fetch(RESET_URL, { method: "POST" });
    } catch {}
  }

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch(STATE_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const s = (await r.json()) as DemoState;
        if (cancelled) return;
        setState(s);
        setConnected(true);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setConnected(false);
        setError(e?.message ?? String(e));
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <section className="page-title">
        <div>
          <div className="eyebrow">Live Netting Demo</div>
          <h2>Watch HyperSettle net opposite intents and unlock USDC</h2>
          <p>
            Mirrors the live state of <code>pnpm demo:netting</code> as it brings
            up local sandboxes, runs two opposite-direction deposits, computes the
            net, and unlocks both legs with real on-chain transactions. Real Ika
            DKG against the pre-alpha network; local stand-in for the unlock
            signature until MPC sign is online.
          </p>
        </div>
        <span className="conn-pill">
          <span className={`dot${connected ? "" : " bad"}`} />
          {connected ? "Streaming /state" : "Disconnected"}
        </span>
      </section>

      {!connected && (
        <div className="notice" style={{ borderLeftColor: "var(--accent-2)" }}>
          <strong>Settle server not reachable at {SERVER_BASE}.</strong> Start
          it with <code>pnpm settle-server</code> in another terminal.{" "}
          {error && (
            <span className="tag" style={{ display: "block", marginTop: 4 }}>
              {error}
            </span>
          )}
        </div>
      )}

      {connected && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto",
              gap: 14,
              alignItems: "end",
            }}
          >
            <div>
              <label>USDC from Base Sepolia</label>
              <div className="amount-row" style={{ padding: "12px 14px" }}>
                <input
                  className="amount"
                  style={{ fontSize: 26 }}
                  value={baseAmount}
                  onChange={(e) => setBaseAmount(e.target.value)}
                  inputMode="decimal"
                  disabled={isRunning}
                />
                <span className="token-pill">
                  <span className="chain-glyph evm-base">B</span> mUSDC
                </span>
              </div>
              <div className="tag" style={{ marginTop: 4, fontSize: 11 }}>
                will be paid out on Solana to a fresh recipient
              </div>
            </div>
            <div>
              <label>USDC from Solana Devnet</label>
              <div className="amount-row" style={{ padding: "12px 14px" }}>
                <input
                  className="amount"
                  style={{ fontSize: 26 }}
                  value={solAmount}
                  onChange={(e) => setSolAmount(e.target.value)}
                  inputMode="decimal"
                  disabled={isRunning}
                />
                <span className="token-pill">
                  <span className="chain-glyph sol">S</span> mUSDC
                </span>
              </div>
              <div className="tag" style={{ marginTop: 4, fontSize: 11 }}>
                will be paid out on Base to a fresh recipient
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                className="cta"
                onClick={runDemo}
                disabled={isRunning}
                style={{ marginTop: 0, padding: "14px 22px", whiteSpace: "nowrap" }}
              >
                {isRunning
                  ? "Running…"
                  : isDone
                  ? "Run again"
                  : "Run netting"}
              </button>
              {(isDone || state?.phase === "error") && (
                <button
                  className="secondary"
                  onClick={resetState}
                  style={{ padding: "8px 12px", fontSize: 12 }}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          {runError && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)", marginTop: 14 }}>
              <strong className="err">Failed to start</strong>
              <div className="code" style={{ marginTop: 6 }}>
                <span className="err">{runError}</span>
              </div>
            </div>
          )}
          {state?.phase === "error" && (state as any).errorMsg && (
            <div className="notice" style={{ borderLeftColor: "var(--bad)", marginTop: 14 }}>
              <strong className="err">Run failed</strong>
              <div className="code" style={{ marginTop: 6 }}>
                <span className="err">{(state as any).errorMsg}</span>
              </div>
            </div>
          )}
        </section>
      )}

      {state && (
        <>
          <section className="panel">
            <PhaseStrip phase={state.phase} />

            <div className="two-col">
              <div>
                <h3>Ika network</h3>
                <div className="kv">
                  <div className="k">endpoint</div>
                  <div>{state.ika.endpoint}</div>
                  <div className="k">DKG pubkey</div>
                  <div>
                    <HexChip value={state.ika.dkgPubkey} />
                    {state.ika.dkgElapsedMs !== null && (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        {state.ika.dkgElapsedMs}ms
                      </span>
                    )}
                  </div>
                  <div className="k">sign attempt</div>
                  <div className={state.ika.signAttemptError ? "err" : ""}>
                    {state.ika.signAttemptError ?? "—"}
                  </div>
                </div>
              </div>
              <div>
                <h3>Local sandboxes</h3>
                <div className="kv">
                  <div className="k">EVM spoke</div>
                  <div>
                    <HexChip value={state.env.evm.spokeAddr} />
                  </div>
                  <div className="k">EVM mUSDC</div>
                  <div>
                    <HexChip value={state.env.evm.usdcAddr} />
                  </div>
                  <div className="k">EVM Ika</div>
                  <div>
                    <HexChip value={state.env.evm.ikaAddress} />
                  </div>
                  <div className="k">SOL program</div>
                  <div>
                    <HexChip value={state.env.sol.spokeProgram} />
                  </div>
                  <div className="k">SOL mUSDC</div>
                  <div>
                    <HexChip value={state.env.sol.mint} />
                  </div>
                  <div className="k">SOL spoke ika</div>
                  <div>
                    <HexChip value={state.env.sol.signingPubkey} />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <div className="two-col" style={{ marginTop: 20 }}>
            <section className="panel">
              <h3>Deposits</h3>
              <div className="kv">
                <div className="k">EVM tx</div>
                <div>
                  <HexChip value={state.deposits.evm?.txHash ?? null} />
                </div>
                <div className="k">EVM amount</div>
                <div>{fmtUsdc(state.deposits.evm?.amountRaw ?? null)} mUSDC</div>
                <div className="k">EVM intent</div>
                <div>
                  <HexChip value={state.deposits.evm?.intentId ?? null} />
                </div>
                <div className="k">SOL tx</div>
                <div>
                  <HexChip value={state.deposits.sol?.txSig ?? null} />
                </div>
                <div className="k">SOL amount</div>
                <div>{fmtUsdc(state.deposits.sol?.amountRaw ?? null)} mUSDC</div>
              </div>

              {state.net && (
                <>
                  <h3 style={{ marginTop: 18 }}>Net</h3>
                  <div className="kv">
                    <div className="k">base → sol</div>
                    <div>{fmtUsdc(state.net.baseToSolRaw)} mUSDC</div>
                    <div className="k">sol → base</div>
                    <div>{fmtUsdc(state.net.solToBaseRaw)} mUSDC</div>
                    <div className="k">matched</div>
                    <div>{fmtUsdc(state.net.matchedRaw)} mUSDC</div>
                    <div className="k">surplus</div>
                    <div>
                      <strong>{fmtUsdc(state.net.surplusRaw)} mUSDC</strong>
                    </div>
                    <div className="k">direction</div>
                    <div>{state.net.direction}</div>
                  </div>
                </>
              )}
            </section>

            <section className="panel">
              <h3>Unlocks</h3>
              <div className="kv">
                <div className="k">EVM unlock tx</div>
                <div>
                  <HexChip value={state.unlocks.evm?.txHash ?? null} />
                </div>
                <div className="k">user B EVM</div>
                <div>
                  {state.balances.userBOnEvmRaw ? (
                    <strong className="ok">
                      {fmtUsdc(state.balances.userBOnEvmRaw)} mUSDC
                    </strong>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="k">SOL unlock tx</div>
                <div>
                  <HexChip value={state.unlocks.sol?.txSig ?? null} />
                </div>
                <div className="k">user A SOL</div>
                <div>
                  {state.balances.userAOnSolRaw ? (
                    <strong className="ok">
                      {fmtUsdc(state.balances.userAOnSolRaw)} mUSDC
                    </strong>
                  ) : (
                    "—"
                  )}
                </div>
              </div>

              <h3 style={{ marginTop: 18 }}>Spoke vaults</h3>
              <div className="kv">
                <div className="k">EVM vault</div>
                <div>
                  {fmtUsdc(state.balances.evmVaultRaw)} mUSDC{" "}
                  {state.balances.evmVaultRaw && (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      (+1 surplus)
                    </span>
                  )}
                </div>
                <div className="k">SOL vault</div>
                <div>
                  {fmtUsdc(state.balances.solVaultRaw)} mUSDC{" "}
                  {state.balances.solVaultRaw && (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      (-1 deficit)
                    </span>
                  )}
                </div>
              </div>
            </section>
          </div>

          <section className="panel" style={{ marginTop: 20 }}>
            <h3>Activity</h3>
            <div
              style={{
                fontFamily: "var(--code)",
                fontSize: 12,
                maxHeight: 200,
                overflow: "auto",
                background: "var(--panel-3)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 10,
              }}
            >
              {state.log.length === 0 ? (
                <span className="tag">Waiting for events…</span>
              ) : (
                state.log
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <div key={i} style={{ display: "flex", gap: 10 }}>
                      <span className="tag" style={{ flexShrink: 0 }}>
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                      <span>{e.msg}</span>
                    </div>
                  ))
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
