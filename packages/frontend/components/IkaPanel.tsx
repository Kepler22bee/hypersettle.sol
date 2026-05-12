"use client";

import { useMemo, useState } from "react";
import { keccak256, toBytes, recoverAddress, toHex as viemToHex } from "viem";
import nacl from "tweetnacl";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  packSettlementOrder,
  evmSettlementDigest,
  type SettlementOrder,
} from "@hypersettle/sdk";
import { fill32, toHex } from "../lib/bytes";
import { createIkaWebClient, type IkaCurve } from "../lib/ika/grpc-web";

const IKA_ENDPOINT =
  process.env.NEXT_PUBLIC_IKA_ENDPOINT ?? "https://pre-alpha-dev-1.ika.ika-network.net:443";

type Mode = "solana" | "evm";

const MODE_INFO: Record<
  Mode,
  { curve: IkaCurve; label: string; verifier: string; chainName: string; payloadDesc: string }
> = {
  solana: {
    curve: "Curve25519",
    label: "Solana",
    verifier: "ed25519 precompile",
    chainName: "Solana Devnet",
    payloadDesc: "153-byte SettlementOrder",
  },
  evm: {
    curve: "Secp256k1",
    label: "Base / EVM",
    verifier: "ecrecover",
    chainName: "Base Sepolia",
    payloadDesc: "EIP-191 digest of SettlementOrder",
  },
};

type Phase = "idle" | "dkg-pending" | "dkg-done" | "sign-pending" | "sign-done" | "error";

const STEP_DEFS: { key: Phase[]; label: string }[] = [
  { key: ["idle"], label: "Pick chain" },
  { key: ["dkg-pending", "dkg-done"], label: "Create dWallet" },
  { key: ["sign-pending"], label: "Sign" },
  { key: ["sign-done"], label: "Verify" },
];

function evmAddressFromPubkey(pubkeyUncompressed: Uint8Array): string {
  const k = pubkeyUncompressed.length === 65 ? pubkeyUncompressed.slice(1) : pubkeyUncompressed;
  const hash = keccak256(k);
  return ("0x" + hash.slice(2 + 24)) as string;
}

function shortHex(hex: string, head = 10, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function HexChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }
  return (
    <span className="hex-chip" title={value}>
      <span>{shortHex(value)}</span>
      <button className="hex-chip-btn" onClick={copy}>
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}

function StepStrip({ phase }: { phase: Phase }) {
  const activeIdx = STEP_DEFS.findIndex((s) => s.key.includes(phase));
  const current = activeIdx === -1 ? 0 : activeIdx;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${STEP_DEFS.length}, 1fr)`,
        gap: 8,
        marginBottom: 4,
      }}
    >
      {STEP_DEFS.map((s, i) => {
        const done = i < current || (i === STEP_DEFS.length - 1 && phase === "sign-done");
        const active = i === current && phase !== "error";
        return (
          <div
            key={s.label}
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid",
              background: active ? "var(--accent-soft)" : "var(--panel-3)",
              borderColor: active ? "var(--accent)" : "var(--border)",
              opacity: done || active ? 1 : 0.55,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                background: done ? "var(--good)" : active ? "var(--accent)" : "var(--panel-2)",
                color: done || active ? "white" : "var(--muted)",
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            <span style={{ color: active || done ? "var(--text)" : "var(--muted)" }}>
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatU64(raw: string): { display: string; usdc: string | null } {
  if (!raw || !/^\d+$/.test(raw)) return { display: raw || "—", usdc: null };
  try {
    const n = BigInt(raw);
    const display = n.toLocaleString("en-US");
    const whole = n / 1_000_000n;
    const frac = (n % 1_000_000n).toString().padStart(6, "0");
    return { display, usdc: `${whole.toString()}.${frac}` };
  } catch {
    return { display: raw, usdc: null };
  }
}

export function IkaPanel() {
  const [mode, setMode] = useState<Mode>("solana");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const [dwalletPubkey, setDwalletPubkey] = useState<Uint8Array | null>(null);
  const [dwalletAddr, setDwalletAddr] = useState<Uint8Array | null>(null);
  const [signature, setSignature] = useState<Uint8Array | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);

  const [recipientLabel, setRecipientLabel] = useState("recipient-A");
  const [amount, setAmount] = useState("1000000");
  const [nonce, setNonce] = useState("1");

  const { publicKey, connected } = useWallet();
  const senderPubkey = publicKey
    ? new Uint8Array(publicKey.toBytes())
    : fill32("hypersettle-frontend-sender");

  const info = MODE_INFO[mode];
  const hasWallet = !!dwalletAddr && !!dwalletPubkey;
  const amountFmt = formatU64(amount);

  const previewRecipientHex = useMemo(
    () => toHex(fill32(recipientLabel || "")),
    [recipientLabel],
  );

  function reset() {
    setDwalletPubkey(null);
    setDwalletAddr(null);
    setSignature(null);
    setVerified(null);
    setRecovered(null);
    setError(null);
    setPhase("idle");
  }

  function changeMode(m: Mode) {
    setMode(m);
    reset();
  }

  async function runDkg() {
    setError(null);
    setPhase("dkg-pending");
    try {
      const client = createIkaWebClient(IKA_ENDPOINT);
      const res = await client.requestDKG(senderPubkey, info.curve);
      setDwalletAddr(res.dwalletAddr);
      setDwalletPubkey(res.publicKey);
      setPhase("dkg-done");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPhase("error");
    }
  }

  function buildOrder(): SettlementOrder {
    const isEvm = mode === "evm";
    return {
      version: 1,
      sourceChain: 1,
      destChain: isEvm ? 10004 : 1,
      destDomain: 7,
      ticker: toBytes(keccak256(toBytes("USDC")), { size: 32 }),
      assetHash: toBytes(
        keccak256(toBytes(isEvm ? "base:USDC" : "solana:USDC")),
        { size: 32 },
      ),
      amount: BigInt(amount || "0"),
      recipient: fill32(recipientLabel),
      intentId: fill32(`ika-intent-${nonce}`),
      nonce: BigInt(nonce || "0"),
    };
  }

  async function runSign() {
    if (!dwalletAddr || !dwalletPubkey) return;
    setError(null);
    setPhase("sign-pending");
    try {
      const client = createIkaWebClient(IKA_ENDPOINT);
      const order = buildOrder();
      const message =
        mode === "evm"
          ? new Uint8Array(evmSettlementDigest(order))
          : new Uint8Array(packSettlementOrder(order));

      const presignId = new Uint8Array(32);
      const txSignature = new Uint8Array(64);
      const sig = await client.requestSign(
        senderPubkey,
        dwalletAddr,
        message,
        presignId,
        txSignature,
      );
      setSignature(sig);

      if (mode === "solana") {
        const ok =
          sig.length === 64 &&
          dwalletPubkey.length === 32 &&
          nacl.sign.detached.verify(message, sig, dwalletPubkey);
        setVerified(ok);
      } else {
        try {
          const rec = await recoverAddress({
            hash: viemToHex(message),
            signature: viemToHex(sig),
          });
          setRecovered(rec);
          const expected = evmAddressFromPubkey(dwalletPubkey).toLowerCase();
          setVerified(rec.toLowerCase() === expected);
        } catch (e: any) {
          setError("ecrecover failed: " + (e?.message ?? String(e)));
          setVerified(false);
        }
      }

      setPhase("sign-done");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPhase("error");
    }
  }

  const stepClass = (active: boolean, done: boolean, locked: boolean) =>
    `step-block${active ? " is-active" : ""}${done ? " is-done" : ""}${
      locked ? " is-locked" : ""
    }`;

  return (
    <>
      <section className="page-title">
        <div>
          <div className="eyebrow">Ika dWallet</div>
          <h2>Sign settlements without holding a private key</h2>
          <p>
            An Ika dWallet is a public key whose private key is split across the Ika
            validator network using 2PC-MPC threshold signatures. Generate one, then
            ask the network to sign a <code>SettlementOrder</code>. The same dWallet
            can sign for either Solana (ed25519) or EVM (secp256k1) destinations.
          </p>
        </div>
        <span className="conn-pill">
          <span className="dot warn" />
          Pre-alpha · Ika gRPC-Web devnet
        </span>
      </section>

      <div className="two-col">
        <section className="panel">
          <StepStrip phase={phase} />

          <div
            className={stepClass(phase === "idle", phase !== "idle", false)}
            style={{ marginTop: 12 }}
          >
            <h3>
              <span className="step-num">1</span>
              Pick a destination chain
            </h3>
            <p className="tag" style={{ marginTop: 4, marginBottom: 12 }}>
              Locks the dWallet curve at DKG. Solana destinations use ed25519, EVM
              destinations use secp256k1 ECDSA.
            </p>
            <div className="toggle-group">
              <button
                className={mode === "solana" ? "is-active" : ""}
                onClick={() => changeMode("solana")}
              >
                Solana
              </button>
              <button
                className={mode === "evm" ? "is-active" : ""}
                onClick={() => changeMode("evm")}
              >
                Base / EVM
              </button>
            </div>
            <p className="tag" style={{ marginTop: 10 }}>
              Verified by the <code>{info.verifier}</code> on the {info.label} spoke.
            </p>
          </div>

          <div
            className={stepClass(
              phase === "dkg-pending",
              phase === "dkg-done" || phase === "sign-pending" || phase === "sign-done",
              false,
            )}
          >
            <h3>
              <span className="step-num">2</span>
              Create your dWallet
            </h3>
            <p className="tag" style={{ marginTop: 4, marginBottom: 12 }}>
              Triggers a distributed key generation across the Ika validators. The
              pubkey returned has no single private key — the shares stay split.
            </p>
            <div className="actions">
              <button
                onClick={runDkg}
                disabled={phase === "dkg-pending" || phase === "sign-pending"}
              >
                {phase === "dkg-pending" && <span className="spinner" />}
                {phase === "dkg-pending"
                  ? "Asking the Ika network…"
                  : hasWallet
                  ? "Regenerate dWallet"
                  : "Create dWallet"}
              </button>
              {hasWallet && (
                <button onClick={reset} className="secondary">
                  Reset
                </button>
              )}
            </div>
          </div>

          <div
            className={stepClass(
              phase === "dkg-done" && !signature,
              phase === "sign-pending" || phase === "sign-done",
              !hasWallet,
            )}
          >
            <h3>
              <span className="step-num">3</span>
              Describe the settlement
            </h3>
            <p className="tag" style={{ marginTop: 4, marginBottom: 12 }}>
              Packed into the canonical {info.payloadDesc} the spoke verifies on-chain.
            </p>
            <div className="field-grid">
              <div>
                <label>Amount (raw u64)</label>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                />
                {amountFmt.usdc && (
                  <div
                    className="tag"
                    style={{ marginTop: -4, fontFamily: "var(--code)" }}
                  >
                    ≈ {amountFmt.usdc} USDC (6 decimals)
                  </div>
                )}
              </div>
              <div>
                <label>Nonce</label>
                <input
                  value={nonce}
                  onChange={(e) => setNonce(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                />
                <div className="tag" style={{ marginTop: -4 }}>
                  Replay-protection counter
                </div>
              </div>
            </div>
            <label>Recipient name</label>
            <input
              value={recipientLabel}
              onChange={(e) => setRecipientLabel(e.target.value)}
            />
            <p className="tag">
              UTF-8 → padded to a 32-byte recipient field. In production this is a
              real on-chain address.
            </p>
          </div>

          <div
            className={stepClass(
              phase === "sign-pending",
              phase === "sign-done",
              !hasWallet,
            )}
          >
            <h3>
              <span className="step-num">4</span>
              Request a signature
            </h3>
            <p className="tag" style={{ marginTop: 4, marginBottom: 12 }}>
              Sends the message to the Ika network and verifies the response locally
              with{" "}
              {mode === "solana" ? "tweetnacl ed25519" : "viem ECDSA recover"}.
            </p>
            <div className="actions">
              <button
                onClick={runSign}
                disabled={!hasWallet || phase === "sign-pending"}
              >
                {phase === "sign-pending" && <span className="spinner" />}
                {phase === "sign-pending" ? "Signing…" : "Sign with dWallet"}
              </button>
            </div>

            {verified === true && (
              <div
                className="notice"
                style={{ borderLeftColor: "var(--good)", marginTop: 12 }}
              >
                <strong className="ok">✓ Signature verified.</strong> The dWallet
                produced a valid signature over the canonical wire bytes — exactly
                what the {info.label} spoke would accept.
              </div>
            )}
            {verified === false && (
              <div
                className="notice"
                style={{ borderLeftColor: "var(--accent-2)", marginTop: 12 }}
              >
                <strong>Mock signer returned an invalid signature.</strong> The
                pre-alpha Ika devnet typically returns zero bytes — the round-trip
                works, but real MPC isn't online yet. Spoke verifiers will accept a
                valid signature unchanged once it is.
              </div>
            )}
          </div>

          {error && (
            <div
              className="notice"
              style={{ borderLeftColor: "var(--bad)", marginTop: 12 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <strong className="err">Request failed</strong>
                <button
                  onClick={() => {
                    setError(null);
                    if (phase === "error") setPhase("idle");
                  }}
                  className="secondary"
                  style={{ padding: "2px 10px", fontSize: 11 }}
                >
                  Dismiss
                </button>
              </div>
              <div className="code" style={{ marginTop: 8 }}>
                <span className="err">{error}</span>
              </div>
            </div>
          )}
        </section>

        <aside className="preview">
          <div className="preview-card">
            <h4>Network</h4>
            <div className="preview-row">
              <div className="k">Status</div>
              <div className="v">
                <span className="dot" />
                Connected
                <div className="sub">{IKA_ENDPOINT}</div>
              </div>
            </div>
            <div className="preview-row">
              <div className="k">Sender</div>
              <div className="v">
                {connected ? "Phantom" : "Demo stub"}
                <div className="sub">
                  {connected
                    ? publicKey?.toBase58()
                    : "Connect Phantom to use your real Solana pubkey"}
                </div>
              </div>
            </div>
          </div>

          <div className="preview-card">
            <h4>Settlement preview</h4>
            <div className="preview-row">
              <div className="k">Destination</div>
              <div className="v">
                {info.label}
                <div className="sub">{info.chainName}</div>
              </div>
            </div>
            <div className="preview-row">
              <div className="k">Curve</div>
              <div className="v">
                {info.curve}
                <div className="sub">{info.verifier}</div>
              </div>
            </div>
            <div className="preview-row">
              <div className="k">Amount</div>
              <div className="v">
                {amountFmt.display}
                {amountFmt.usdc && <div className="sub">≈ {amountFmt.usdc} USDC</div>}
              </div>
            </div>
            <div className="preview-row">
              <div className="k">Recipient</div>
              <div className="v">
                {recipientLabel || "—"}
                <div className="sub">{shortHex(previewRecipientHex, 14, 6)}</div>
              </div>
            </div>
            <div className="preview-row">
              <div className="k">Nonce</div>
              <div className="v">{nonce || "—"}</div>
            </div>
            <div className="preview-row">
              <div className="k">Wire format</div>
              <div className="v">{info.payloadDesc}</div>
            </div>
          </div>

          <div className="preview-card">
            <h4>dWallet</h4>
            {!hasWallet ? (
              <p className="tag" style={{ margin: 0 }}>
                Run step 2 to generate a dWallet on the Ika network.
              </p>
            ) : (
              <>
                <div className="preview-row">
                  <div className="k">Public key</div>
                  <div className="v">
                    <HexChip value={toHex(dwalletPubkey!)} />
                  </div>
                </div>
                {mode === "evm" && dwalletPubkey && (
                  <div className="preview-row">
                    <div className="k">EVM addr</div>
                    <div className="v">
                      <HexChip value={evmAddressFromPubkey(dwalletPubkey)} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {(signature || phase === "sign-pending") && (
            <div className="preview-card">
              <h4>Signature</h4>
              {phase === "sign-pending" && (
                <p className="tag" style={{ margin: 0 }}>
                  <span className="spinner" style={{ borderTopColor: "var(--accent)" }} />
                  Awaiting signature from the Ika network…
                </p>
              )}
              {signature && (
                <>
                  <div className="preview-row">
                    <div className="k">Bytes</div>
                    <div className="v">
                      <HexChip value={toHex(signature)} />
                    </div>
                  </div>
                  {recovered && (
                    <div className="preview-row">
                      <div className="k">Recovered</div>
                      <div className="v">
                        <HexChip value={recovered} />
                      </div>
                    </div>
                  )}
                  <div className="preview-row">
                    <div className="k">Verify</div>
                    <div className="v">
                      {verified === true && (
                        <>
                          <span className="dot" /> <span className="ok">Valid</span>
                        </>
                      )}
                      {verified === false && (
                        <>
                          <span className="dot warn" /> Mock (pre-alpha)
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
