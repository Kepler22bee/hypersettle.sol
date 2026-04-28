"use client";

import { useState } from "react";
import { keccak256, toBytes } from "viem";
import nacl from "tweetnacl";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  packSettlementOrder,
  type SettlementOrder,
} from "@hypersettle/sdk";
import { fill32, toHex } from "../lib/bytes";
import { createIkaWebClient } from "../lib/ika/grpc-web";

const IKA_ENDPOINT =
  process.env.NEXT_PUBLIC_IKA_ENDPOINT ?? "https://pre-alpha-dev-1.ika.ika-network.net:443";

type Phase =
  | "idle"
  | "dkg-pending"
  | "dkg-done"
  | "sign-pending"
  | "sign-done"
  | "error";

export function IkaPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const [dwalletPubkey, setDwalletPubkey] = useState<Uint8Array | null>(null);
  const [dwalletAddr, setDwalletAddr] = useState<Uint8Array | null>(null);
  const [signature, setSignature] = useState<Uint8Array | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);

  const [recipientLabel, setRecipientLabel] = useState("solana-recipient-A");
  const [amount, setAmount] = useState("1000000");
  const [nonce, setNonce] = useState("1");

  const { publicKey, connected } = useWallet();
  const senderPubkey = publicKey
    ? new Uint8Array(publicKey.toBytes())
    : fill32("hypersettle-frontend-sender");

  async function runDkg() {
    setError(null);
    setPhase("dkg-pending");
    try {
      const client = createIkaWebClient(IKA_ENDPOINT);
      const res = await client.requestDKG(senderPubkey);
      setDwalletAddr(res.dwalletAddr);
      setDwalletPubkey(res.publicKey);
      setPhase("dkg-done");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPhase("error");
    }
  }

  async function runSign() {
    if (!dwalletAddr) return;
    setError(null);
    setPhase("sign-pending");
    try {
      const client = createIkaWebClient(IKA_ENDPOINT);

      // The order the spoke would receive. For Ika (Curve25519 / ed25519) the
      // signed bytes are the canonical packed order; the destination Solana
      // spoke verifies via the ed25519 precompile.
      const order: SettlementOrder = {
        version: 1,
        sourceChain: 1,
        destChain: 1,
        destDomain: 7,
        ticker: toBytes(keccak256(toBytes("USDC")), { size: 32 }),
        assetHash: toBytes(keccak256(toBytes("solana:USDC")), { size: 32 }),
        amount: BigInt(amount),
        recipient: fill32(recipientLabel),
        intentId: fill32(`ika-intent-${nonce}`),
        nonce: BigInt(nonce),
      };
      const message = new Uint8Array(packSettlementOrder(order));

      // pre-alpha mock signer accepts zeroed presign + tx-signature (per the
      // upstream client patterns).
      const presignId = new Uint8Array(32);
      const txSignature = new Uint8Array(64);
      const sig = await client.requestSign(senderPubkey, dwalletAddr, message, presignId, txSignature);
      setSignature(sig);

      // Verify locally with the dWallet pubkey we got from DKG.
      if (dwalletPubkey && sig.length === 64) {
        const ok = nacl.sign.detached.verify(message, sig, dwalletPubkey);
        setVerified(ok);
      } else {
        setVerified(null);
      }
      setPhase("sign-done");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPhase("error");
    }
  }

  return (
    <section className="panel">
      <h2>Ika dWallet (devnet)</h2>
      <p className="tag">
        Calls the Ika pre-alpha gRPC-Web endpoint. Pre-alpha mock signer; no
        real MPC. dWallets default to Curve25519 → ed25519 sigs, which the
        Solana spoke's <code>execute_settlement</code> verifies via the
        ed25519 precompile.
      </p>

      <div className="kv" style={{ marginBottom: 12 }}>
        <div className="k">endpoint</div>
        <div>{IKA_ENDPOINT}</div>
        <div className="k">sender</div>
        <div>
          {connected
            ? `${publicKey?.toBase58()} (Phantom)`
            : "demo stub — connect a Solana wallet to use your real pubkey"}
        </div>
        <div className="k">phase</div>
        <div className={phase === "error" ? "err" : phase === "sign-done" ? "ok" : ""}>
          {phase}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={runDkg} disabled={phase === "dkg-pending"}>
          {phase === "dkg-pending" ? "DKG running…" : "1. Generate dWallet (DKG)"}
        </button>
        <button
          onClick={runSign}
          disabled={!dwalletAddr || phase === "sign-pending"}
          className="secondary"
        >
          {phase === "sign-pending" ? "Signing…" : "2. Request signature"}
        </button>
      </div>

      {dwalletPubkey && (
        <>
          <label>dWallet public key (Curve25519)</label>
          <div className="code">{toHex(dwalletPubkey)}</div>
        </>
      )}

      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Amount (u64)</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Nonce</label>
          <input value={nonce} onChange={(e) => setNonce(e.target.value)} />
        </div>
      </div>

      <label>Recipient label (becomes 32-byte recipient field)</label>
      <input value={recipientLabel} onChange={(e) => setRecipientLabel(e.target.value)} />

      {signature && (
        <>
          <label style={{ marginTop: 12 }}>ed25519 signature</label>
          <div className="code">{toHex(signature)}</div>
          {verified !== null && (
            <div className="kv">
              <div className="k">verify</div>
              <div className={verified ? "ok" : "err"}>
                {verified ? "✓ valid against dWallet pubkey" : "✗ failed (mock signer expected)"}
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <>
          <label style={{ marginTop: 12 }}>Error</label>
          <div className="code"><span className="err">{error}</span></div>
        </>
      )}
    </section>
  );
}
