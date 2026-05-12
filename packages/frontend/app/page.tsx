import Link from "next/link";
import { AppShell } from "../components/AppShell";

export default function Home() {
  return (
    <AppShell>
      <section className="page-title">
        <div>
          <div className="eyebrow">Workflow</div>
          <h2>Create intents, match privately, settle with Ika</h2>
          <p>
            HyperSettle collects funded intents in both directions, nets opposite
            flows, and produces one rebalance transaction for the difference
            instead of sending two full cross-chain transfers.
          </p>
        </div>
        <span className="status-pill">Pre-alpha demo</span>
      </section>

      <div className="grid">
        <Link href="/deposit" style={{ textDecoration: "none" }}>
          <section className="route-card">
            <span className="step">1</span>
            <h2>Fund Intent</h2>
            <p>Lock USDC on Solana or Base and choose the opposite destination.</p>
          </section>
        </Link>
        <Link href="/settle" style={{ textDecoration: "none" }}>
          <section className="route-card">
            <span className="step">2</span>
            <h2>Settle</h2>
            <p>Compare both directions, cancel matched flow, and produce one net transaction.</p>
          </section>
        </Link>
        <Link href="/ika" style={{ textDecoration: "none" }}>
          <section className="route-card">
            <span className="step">I</span>
            <h2>Ika Wallets</h2>
            <p>Generate Ika dWallets and test signing for EVM or Solana destinations.</p>
          </section>
        </Link>
      </div>
    </AppShell>
  );
}
