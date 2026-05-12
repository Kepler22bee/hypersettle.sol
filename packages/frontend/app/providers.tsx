"use client";

import { useMemo } from "react";
import { RainbowKitProvider, connectorsForWallets } from "@rainbow-me/rainbowkit";
import { metaMaskWallet } from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { baseSepolia, arbitrumSepolia, sepolia } from "wagmi/chains";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";

import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";

// MetaMask-only EVM connectors. Bypasses Coinbase Smart Wallet (passkey
// popups) and WalletConnect to keep the signing flow free of new-window
// gestures.
const connectors = connectorsForWallets(
  [{ groupName: "EVM", wallets: [metaMaskWallet] }],
  {
    appName: "HyperSettle",
    projectId:
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "00000000000000000000000000000000",
  },
);

const evmConfig = createConfig({
  connectors,
  chains: [baseSepolia, arbitrumSepolia, sepolia],
  transports: {
    [baseSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: true,
});

const queryClient = new QueryClient();

const SOL_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
const SOL_NETWORK = WalletAdapterNetwork.Devnet;

export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter({ network: SOL_NETWORK })], []);
  return (
    <WagmiProvider config={evmConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <ConnectionProvider endpoint={SOL_RPC}>
            <WalletProvider wallets={wallets} autoConnect>
              <WalletModalProvider>{children}</WalletModalProvider>
            </WalletProvider>
          </ConnectionProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
