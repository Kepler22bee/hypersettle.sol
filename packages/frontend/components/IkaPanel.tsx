"use client";

import { useState } from "react";
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

const MODE_INFO: Record<Mode, { curve: IkaCurve; signsWhat: string; verifies: string }> = {
  solana: {
    curve: "Curve25519",
    signsWhat: "raw packed SettlementOrder bytes (153B)",
    verifies: "ed25519 against the dWallet pubkey (matches Solana spoke's ed25519 precompile)",
  },
  evm: {
    curve: "Secp256k1",
    signsWhat: "EIP-191 digest of the packed SettlementOrder",
    verifies: "ECDSA recover → must match dWallet address (matches EVM spoke's ecrecover)",
  },
};

type Phase = "idle" | "dkg-pending" | "dkg-done" | "sign-pending" | "sign-done" | "error";

function evmAddressFromPubkey(pubkeyUncompressed: Uint8Array): string {
  // secp256k1 uncompressed pubkey is 64 bytes (no 0x04 prefix) or 65 with prefix.
  const k = pubkeyUncompressed.length === 65 ? pubkeyUncompressed.slice(1) : pubkeyUncompressed;
  const hash = keccak256(k);
  return ("0x" + hash.slice(2 + 24)) as string; // last 20 bytes
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

  function reset() {
    setDwalletPubkey(null);
    setDwalletAddr(null);
    setSignature(null);
    setVerified(null);
    setRecovered(null);
    setError(null);
    setPhase("idle");
  }

  function changeMode(m: Mode) { setMode(m); reset(); }

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
      destChain: isEvm ? 10004 /* Base Sepolia */ : 1 /* Solana */,
      destDomain: 7,
      ticker: toBytes(keccak256(toBytes("USDC")), { size: 32 }),
      assetHash: toBytes(
        keccak256(toBytes(isEvm ? "base:USDC" : "solana:USDC")),
        { size: 32 },
      ),
      amount: BigInt(amount),
      recipient: fill32(recipientLabel),
      intentId: fill32(`ika-intent-${nonce}`),
      nonce: BigInt(nonce),
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
          ? new Uint8Array(evmSettlementDigest(order)) // 32-byte EIP-191 digest
          : new Uint8Array(packSettlementOrder(order)); // 153 raw bytes

      const presignId = new Uint8Array(32);
      const txSignature = new Uint8Array(64);
      const sig = await client.requestSign(senderPubkey, dwalletAddr, message, presignId, txSignature);
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

  return (
    <section className="panel">
      <h2>Ika dWallet (devnet)</h2>
      <p className="tag">
        Calls the Ika pre-alpha gRPC-Web endpoint. Pre-alpha mock signer; no real MPC.
        The same dWallet network can sign for both destinations — pick the curve at DKG.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          className={mode === "solana" ? "" : "secondary"}
          onClick={() => changeMode("solana")}
        >
          Solana destination (Curve25519 / ed25519)
        </button>
        <button
          className={mode === "evm" ? "" : "secondary"}
          onClick={() => changeMode("evm")}
        >
          EVM destination (Secp256k1 / ECDSA)
        </button>
      </div>

      <div className="kv" style={{ marginBottom: 12 }}>
        <div className="k">endpoint</div>
        <div>{IKA_ENDPOINT}</div>
        <div className="k">curve</div>
        <div>{info.curve}</div>
        <div className="k">signs</div>
        <div>{info.signsWhat}</div>
        <div className="k">verifies</div>
        <div>{info.verifies}</div>
        <div className="k">sender</div>
        <div>
          {connected
            ? `${publicKey?.toBase58()} (Phantom)`
            : "demo stub — connect Phantom for your real Solana pubkey"}
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
          <label>dWallet public key ({info.curve})</label>
          <div className="code">{toHex(dwalletPubkey)}</div>
          {mode === "evm" && (
            <div className="kv">
              <div className="k">EVM address</div>
              <div>{evmAddressFromPubkey(dwalletPubkey)}</div>
            </div>
          )}
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
          <label style={{ marginTop: 12 }}>{info.curve} signature</label>
          <div className="code">{toHex(signature)}</div>
          {recovered && (
            <div className="kv">
              <div className="k">recovered</div>
              <div>{recovered}</div>
            </div>
          )}
          {verified !== null && (
            <div className="kv">
              <div className="k">verify</div>
              <div className={verified ? "ok" : "err"}>
                {verified
                  ? "✓ matches dWallet"
                  : "✗ failed (mock signer typically returns zeros — expected pre-alpha)"}
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
