import Link from "next/link";
import { AppShell } from "../components/AppShell";

export default function Home() {
  return (
    <AppShell>
      <section className="panel" style={{ marginBottom: 20 }}>
        <h2>What this is</h2>
        <p style={{ color: "var(--muted)", lineHeight: 1.6, marginTop: 0, marginBottom: 12 }}>
          A live wire-format explorer for HyperSettle. Each section below packs the
          canonical bytes the on-chain hub and EVM/Solana spokes exchange — same byte
          layout as <code>packages/shared/messages.md</code>. Pick a section from the
          header.
        </p>
      </section>

      <div className="grid">
        <Link href="/deposit" style={{ textDecoration: "none" }}>
          <section className="panel">
            <h2>Deposit (143 bytes) →</h2>
            <p className="tag">Spoke side, EVM. Build a <code>DepositIntent</code> with an Encrypt ciphertext-pubkey handle.</p>
          </section>
        </Link>
        <Link href="/invoice" style={{ textDecoration: "none" }}>
          <section className="panel">
            <h2>Invoice (145 bytes) →</h2>
            <p className="tag">Spoke side, EVM. Request a settlement to a recipient on another chain.</p>
          </section>
        </Link>
        <Link href="/settle" style={{ textDecoration: "none" }}>
          <section className="panel">
            <h2>EVM Settle (153 bytes + sig) →</h2>
            <p className="tag">Hub-side reveal output. Local mock secp256k1 / EIP-191 — same recover path as on-chain executeSettlement.</p>
          </section>
        </Link>
        <Link href="/ika" style={{ textDecoration: "none" }}>
          <section className="panel">
            <h2>Ika dWallet (Solana) →</h2>
            <p className="tag">Calls Ika devnet gRPC-Web. Curve25519 dWallet → ed25519 sig → verified locally with <code>nacl</code>.</p>
          </section>
        </Link>
      </div>
    </AppShell>
  );
}
