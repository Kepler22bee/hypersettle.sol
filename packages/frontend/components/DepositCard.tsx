"use client";

import { useMemo, useState } from "react";
import { keccak256, toBytes } from "viem";
import { packDepositIntent, type DepositIntent } from "@hypersettle/sdk";
import { fill32, randomCt, toHex } from "../lib/bytes";

export function DepositCard() {
  const [ticker, setTicker] = useState("USDC");
  const [amount, setAmount] = useState("1000000");
  const [epoch, setEpoch] = useState("5");
  const [domain, setDomain] = useState("7");
  const [sourceChain, setSourceChain] = useState("10004"); // Base Sepolia (Wormhole)
  const [intentLabel, setIntentLabel] = useState("deposit-A");
  const [tick, setTick] = useState(0); // bumps to regenerate ct

  const intent = useMemo<DepositIntent>(() => {
    void tick;
    return {
      version: 1,
      sourceChain: parseInt(sourceChain, 10),
      sourceDomain: parseInt(domain, 10),
      ticker: toBytes(keccak256(toBytes(ticker)), { size: 32 }),
      assetHash: toBytes(keccak256(toBytes(`${sourceChain}:${ticker}`)), { size: 32 }),
      epoch: BigInt(epoch),
      amountCt: randomCt(),
      intentId: fill32(intentLabel),
    };
  }, [ticker, sourceChain, domain, epoch, intentLabel, tick]);

  const packed = useMemo(() => packDepositIntent(intent), [intent]);

  return (
    <section className="panel">
      <h2>Deposit intent (143 bytes)</h2>
      <p className="tag">Spoke-side: encrypt amount client-side, then post a Wormhole VAA carrying the ciphertext handle.</p>

      <label>Ticker</label>
      <input value={ticker} onChange={(e) => setTicker(e.target.value)} />

      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Amount (plaintext, custodied)</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Epoch</label>
          <input value={epoch} onChange={(e) => setEpoch(e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Source chain (Wormhole id)</label>
          <input value={sourceChain} onChange={(e) => setSourceChain(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Source domain</label>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} />
        </div>
      </div>

      <label>Intent label (becomes intent_id seed)</label>
      <input value={intentLabel} onChange={(e) => setIntentLabel(e.target.value)} />

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setTick((t) => t + 1)} className="secondary">Regenerate ct handle</button>
      </div>

      <div className="kv">
        <div className="k">amount_ct (handle)</div><div>{toHex(intent.amountCt)}</div>
        <div className="k">intent_id</div><div>{toHex(intent.intentId)}</div>
        <div className="k">payload bytes</div><div>{packed.length}</div>
      </div>
      <label style={{ marginTop: 12 }}>Wire payload</label>
      <div className="code">{toHex(packed)}</div>
    </section>
  );
}
