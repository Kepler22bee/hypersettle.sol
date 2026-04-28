"use client";

import { useMemo, useState } from "react";
import { keccak256, toBytes, recoverAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  packSettlementOrder,
  evmSettlementDigest,
  type SettlementOrder,
} from "@hypersettle/sdk";
import { fill32, paddedAddr, toHex } from "../lib/bytes";

export function SettlementCard() {
  const [ikaKey, setIkaKey] = useState<Hex | null>(null);
  const [ikaAddr, setIkaAddr] = useState<string | null>(null);

  const [recipient, setRecipient] = useState("0x000000000000000000000000000000000000beef");
  const [amount, setAmount] = useState("1000000");
  const [nonce, setNonce] = useState("1");
  const [destChain, setDestChain] = useState("10004");
  const [destDomain, setDestDomain] = useState("7");
  const [intentLabel, setIntentLabel] = useState("invoice-1");

  const [signature, setSignature] = useState<Hex | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  function generateIka() {
    const k = generatePrivateKey();
    setIkaKey(k);
    setIkaAddr(privateKeyToAccount(k).address);
    setSignature(null);
    setRecovered(null);
    setVerified(null);
    setError(null);
  }

  const order = useMemo<SettlementOrder>(() => ({
    version: 1,
    sourceChain: 1, // Solana hub
    destChain: parseInt(destChain, 10),
    destDomain: parseInt(destDomain, 10),
    ticker: toBytes(keccak256(toBytes("USDC")), { size: 32 }),
    assetHash: toBytes(keccak256(toBytes(`base:USDC`)), { size: 32 }),
    amount: BigInt(amount),
    recipient: paddedAddr(recipient as `0x${string}`),
    intentId: fill32(intentLabel),
    nonce: BigInt(nonce),
  }), [recipient, amount, nonce, destChain, destDomain, intentLabel]);

  const packed = useMemo(() => packSettlementOrder(order), [order]);
  const digest = useMemo(() => evmSettlementDigest(order), [order]);

  async function signAndVerify() {
    setError(null);
    setSignature(null);
    setRecovered(null);
    setVerified(null);
    if (!ikaKey || !ikaAddr) {
      setError("Generate a mock Ika dWallet first.");
      return;
    }
    try {
      const acct = privateKeyToAccount(ikaKey);
      const sig = await acct.sign({ hash: toHex(digest) as Hex });
      setSignature(sig);
      const rec = await recoverAddress({ hash: toHex(digest) as Hex, signature: sig });
      setRecovered(rec);
      setVerified(rec.toLowerCase() === ikaAddr.toLowerCase());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  return (
    <section className="panel">
      <h2>Settlement bundle (153 bytes + Ika signature)</h2>
      <p className="tag">Hub-side reveal output. The mock Ika dWallet here stands in for the threshold signing network; the EIP-191 digest path is identical to <code>Messages.settlementDigest</code> on the EVM spoke.</p>

      <label>Mock Ika dWallet</label>
      <div className="row" style={{ marginBottom: 12 }}>
        <input readOnly value={ikaAddr ?? "(none — generate one)"} />
        <button className="secondary" onClick={generateIka}>Generate</button>
      </div>

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

      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Dest chain (Wormhole id)</label>
          <input value={destChain} onChange={(e) => setDestChain(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Dest domain</label>
          <input value={destDomain} onChange={(e) => setDestDomain(e.target.value)} />
        </div>
      </div>

      <label>Recipient (EVM address)</label>
      <input value={recipient} onChange={(e) => setRecipient(e.target.value)} />

      <label>Intent label</label>
      <input value={intentLabel} onChange={(e) => setIntentLabel(e.target.value)} />

      <div style={{ marginTop: 8, marginBottom: 12 }}>
        <button onClick={signAndVerify} disabled={!ikaKey}>Sign + verify</button>
      </div>

      <div className="kv">
        <div className="k">packed bytes</div><div>{packed.length}</div>
        <div className="k">EIP-191 digest</div><div>{toHex(digest)}</div>
      </div>
      <label style={{ marginTop: 12 }}>Wire payload</label>
      <div className="code">{toHex(packed)}</div>

      {signature && (
        <>
          <label>Ika signature</label>
          <div className="code">{signature}</div>
        </>
      )}

      {recovered && (
        <div className="kv">
          <div className="k">recovered</div><div>{recovered}</div>
          <div className="k">match</div>
          <div className={verified ? "ok" : "err"}>
            {verified ? "✓ matches registered dWallet" : "✗ mismatch"}
          </div>
        </div>
      )}

      {error && <div className="code"><span className="err">{error}</span></div>}
    </section>
  );
}
