"use client";

import { useMemo, useState } from "react";
import { keccak256, toBytes } from "viem";
import { useAccount } from "wagmi";
import { packInvoiceIntent, type InvoiceIntent } from "@hypersettle/sdk";
import { fill32, paddedAddr, randomCt, toHex } from "../lib/bytes";

export function InvoiceCard() {
  const { address } = useAccount();
  const [ticker, setTicker] = useState("USDC");
  const [epoch, setEpoch] = useState("5");
  const [domain, setDomain] = useState("9");
  const [sourceChain, setSourceChain] = useState("10003"); // Arbitrum Sepolia
  const [recipientChain, setRecipientChain] = useState("10004"); // Base Sepolia
  const [intentLabel, setIntentLabel] = useState("invoice-1");
  const [tick, setTick] = useState(0);

  const recipient = address ?? "0x0000000000000000000000000000000000000000";

  const intent = useMemo<InvoiceIntent>(() => {
    void tick;
    return {
      version: 1,
      sourceChain: parseInt(sourceChain, 10),
      sourceDomain: parseInt(domain, 10),
      ticker: toBytes(keccak256(toBytes(ticker)), { size: 32 }),
      epoch: BigInt(epoch),
      amountCt: randomCt(),
      recipientChain: parseInt(recipientChain, 10),
      recipient: paddedAddr(recipient as `0x${string}`),
      intentId: fill32(intentLabel),
    };
  }, [ticker, sourceChain, domain, epoch, recipientChain, recipient, intentLabel, tick]);

  const packed = useMemo(() => packInvoiceIntent(intent), [intent]);

  return (
    <section className="panel">
      <h2>Invoice intent (145 bytes)</h2>
      <p className="tag">Request a settlement to a recipient on another chain. The invoice amount is encrypted; only the recipient is plaintext.</p>

      <label>Ticker</label>
      <input value={ticker} onChange={(e) => setTicker(e.target.value)} />

      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Source chain</label>
          <input value={sourceChain} onChange={(e) => setSourceChain(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Source domain</label>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Recipient chain</label>
          <input value={recipientChain} onChange={(e) => setRecipientChain(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Epoch</label>
          <input value={epoch} onChange={(e) => setEpoch(e.target.value)} />
        </div>
      </div>

      <label>Recipient (uses connected wallet)</label>
      <input value={recipient} readOnly />

      <label>Intent label</label>
      <input value={intentLabel} onChange={(e) => setIntentLabel(e.target.value)} />

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setTick((t) => t + 1)} className="secondary">Regenerate ct handle</button>
      </div>

      <div className="kv">
        <div className="k">amount_ct (handle)</div><div>{toHex(intent.amountCt)}</div>
        <div className="k">recipient (32B)</div><div>{toHex(intent.recipient)}</div>
        <div className="k">intent_id</div><div>{toHex(intent.intentId)}</div>
        <div className="k">payload bytes</div><div>{packed.length}</div>
      </div>
      <label style={{ marginTop: 12 }}>Wire payload</label>
      <div className="code">{toHex(packed)}</div>
    </section>
  );
}
