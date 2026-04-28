"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { DepositCard } from "../components/DepositCard";
import { InvoiceCard } from "../components/InvoiceCard";
import { SettlementCard } from "../components/SettlementCard";
import { IkaPanel } from "../components/IkaPanel";

export default function Home() {
  return (
    <main>
      <header className="app-header">
        <div>
          <h1>HyperSettle</h1>
          <div className="tag">Encrypted netting · Encrypt FHE · Ika threshold signatures · Solana hub · EVM + Solana spokes</div>
        </div>
        <ConnectButton />
      </header>

      <section className="panel" style={{ marginBottom: 20 }}>
        <h2>What this is</h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.6, margin: 0 }}>
          A live wire-format explorer. The same SDK helpers used by the on-chain hub
          and EVM/Solana spokes pack <strong>DepositIntent</strong>, <strong>InvoiceIntent</strong>,
          and <strong>SettlementOrder</strong> in the browser. Every panel below
          shows the resulting bytes byte-for-byte, the digest the registered Ika dWallet
          would sign, and (for settlement) a local mock Ika key whose ECDSA signature
          recovers to the same address an on-chain <code>executeSettlement</code> verifies.
        </p>
      </section>

      <div className="grid">
        <DepositCard />
        <InvoiceCard />
      </div>

      <div className="grid" style={{ marginTop: 20 }}>
        <SettlementCard />
        <IkaPanel />
      </div>

      <footer>
        Status: pre-alpha demo · No live RPC calls (mocks for Encrypt + Ika).
        Run <code>pnpm --filter ./packages/sdk run demo</code> for the equivalent CLI flow.
      </footer>
    </main>
  );
}
