"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";

type ChainKind = "evm" | "solana" | "none";

const NAV: { href: string; label: string; chain: ChainKind }[] = [
  { href: "/", label: "Overview", chain: "none" },
  { href: "/deposit", label: "Deposit", chain: "evm" },
  { href: "/invoice", label: "Invoice", chain: "evm" },
  { href: "/settle", label: "EVM Settle", chain: "evm" },
  { href: "/ika", label: "Ika dWallet", chain: "solana" },
];

// The Solana WalletMultiButton imports indexedDB at module top-level. Avoid
// SSR by lazy-loading it client-side only.
function SolanaConnect() {
  const [Cmp, setCmp] = useState<React.ComponentType<any> | null>(null);
  useEffect(() => {
    let mounted = true;
    import("@solana/wallet-adapter-react-ui").then((m) => {
      if (mounted) setCmp(() => m.WalletMultiButton);
    });
    return () => { mounted = false; };
  }, []);
  return Cmp ? <Cmp /> : <button className="secondary" disabled>Loading…</button>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const current = NAV.find((n) => n.href === path);
  const chain: ChainKind = current?.chain ?? "none";

  return (
    <main>
      <header className="app-header">
        <div className="brand">
          <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
            <h1>HyperSettle</h1>
          </Link>
          <div className="tag">Encrypted netting · Encrypt FHE · Ika dWallets</div>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={"nav-link " + (path === n.href ? "active" : "")}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="connect">
          {chain === "evm" && <ConnectButton />}
          {chain === "solana" && <SolanaConnect />}
          {chain === "none" && <span className="tag">No wallet needed</span>}
        </div>
      </header>

      {children}

      <footer>
        Status: pre-alpha demo · EVM connect via RainbowKit · Solana connect via wallet-adapter (Phantom).
      </footer>
    </main>
  );
}
