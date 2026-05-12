"use client";

import { useEffect, useMemo, useState } from "react";
import {
  encodePacked,
  formatUnits,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { packDepositIntent, type DepositIntent } from "@hypersettle/sdk";
import { fill32, randomCt, toHex } from "../lib/bytes";

// Token mints used by /deposit. Defaults are the real Circle / Solana
// USDC mints, but the netting-testnet deployment binds the spoke to our
// own MockUSDC — set NEXT_PUBLIC_BASE_SEPOLIA_USDC / NEXT_PUBLIC_SOLANA_USDC
// in .env.local to point the UI at whichever mint the spoke actually
// recognises.
const BASE_SEPOLIA_USDC = (process.env.NEXT_PUBLIC_BASE_SEPOLIA_USDC ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;
const ARBITRUM_SEPOLIA_USDC = (process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_USDC ??
  "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as `0x${string}`;
const SOLANA_DEVNET_USDC =
  process.env.NEXT_PUBLIC_SOLANA_USDC ??
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_SPOKE_PROGRAM =
  process.env.NEXT_PUBLIC_SOLANA_SPOKE_PROGRAM_ID ??
  "4YbN6dZNNgvRDnYtASGyto69S1gxJB5mZnFS1tpvDHGw";
const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const DEFAULT_EVM_SPOKE =
  (process.env.NEXT_PUBLIC_EVM_SPOKE_ADDRESS as Address | undefined) ?? "";

const NETWORKS = {
  baseSepolia: {
    label: "Base Sepolia",
    evmChainId: "84532",
    wormholeChain: "10004",
    domain: "7",
    usdc: BASE_SEPOLIA_USDC,
    kind: "evm",
  },
  arbitrumSepolia: {
    label: "Arbitrum Sepolia",
    evmChainId: "421614",
    wormholeChain: "10003",
    domain: "9",
    usdc: ARBITRUM_SEPOLIA_USDC,
    kind: "evm",
  },
  solanaDevnet: {
    label: "Solana Devnet",
    evmChainId: "0",
    wormholeChain: "1",
    domain: "7",
    usdc: SOLANA_DEVNET_USDC,
    kind: "solana",
  },
} as const;

type NetworkKey = keyof typeof NETWORKS;

const FUNDED_INTENT_KEY = "hypersettle:last-funded-intent";
const FUNDED_INTENTS_KEY = "hypersettle:funded-intents";

function SolanaConnectButton() {
  const [Cmp, setCmp] = useState<React.ComponentType<any> | null>(null);
  useEffect(() => {
    let mounted = true;
    import("@solana/wallet-adapter-react-ui").then((m) => {
      if (mounted) setCmp(() => m.WalletMultiButton);
    });
    return () => { mounted = false; };
  }, []);
  return Cmp ? <Cmp /> : <button className="secondary" disabled>Loading...</button>;
}

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const SPOKE_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "ticker", type: "bytes32" },
      { name: "assetHash", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "amountCt", type: "bytes32" },
      { name: "epoch", type: "uint64" },
    ],
    outputs: [
      { name: "intentId", type: "bytes32" },
      { name: "sequence", type: "uint64" },
    ],
  },
] as const;

function parseUsdcAmount(value: string): bigint {
  try {
    return parseUnits(value || "0", 6);
  } catch {
    return 0n;
  }
}

function parseSafeInt(value: string): number {
  const n = Number.parseInt(value || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function parseSafeBigInt(value: string): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function anchorDepositData(
  ticker: Uint8Array,
  assetHash: Uint8Array,
  amount: bigint,
  amountCt: Uint8Array,
  epoch: bigint,
): Uint8Array {
  const data = new Uint8Array(8 + 32 + 32 + 8 + 32 + 8);
  let o = 0;
  data.set([242, 35, 198, 137, 82, 225, 242, 182], o); o += 8;
  data.set(ticker, o); o += 32;
  data.set(assetHash, o); o += 32;
  data.set(u64le(amount), o); o += 8;
  data.set(amountCt, o); o += 32;
  data.set(u64le(epoch), o);
  return data;
}

function ataAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function DepositCard() {
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain();
  const { connection } = useConnection();
  const solanaWallet = useWallet();

  const [amount, setAmount] = useState("10");
  const [networkKey, setNetworkKey] = useState<NetworkKey>("baseSepolia");
  const [destinationNetworkKey, setDestinationNetworkKey] = useState<NetworkKey>("baseSepolia");
  const [recipient, setRecipient] = useState("0x0000000000000000000000000000000000000000");
  const [spokeAddress, setSpokeAddress] = useState<string>(DEFAULT_EVM_SPOKE);
  const [tick, setTick] = useState(0); // bumps to regenerate ct
  const [approveHash, setApproveHash] = useState<Hex | null>(null);
  const [depositHash, setDepositHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [solanaGenesis, setSolanaGenesis] = useState<string | null>(null);

  const network = NETWORKS[networkKey];
  const destinationNetwork = NETWORKS[destinationNetworkKey];
  const ticker = "USDC";
  const epoch = "5";
  const intentLabel = `${networkKey}-to-${destinationNetworkKey}`;
  const sourceChain = network.wormholeChain;
  const domain = network.domain;
  const evmChainId = network.evmChainId;
  const tokenAddress = network.usdc;
  const destinationChain = destinationNetwork.wormholeChain;
  const destinationDomain = destinationNetwork.domain;
  const wormholeFee = 0n;
  const isSolana = network.kind === "solana";
  const amountRaw = useMemo(() => parseUsdcAmount(amount), [amount]);
  const spokeReady = isAddress(spokeAddress);
  const tokenReady = !isSolana;
  const tickerHash = useMemo(() => keccak256(toBytes(ticker)), [ticker]);
  const assetHash = useMemo(
    () =>
      isSolana
        ? toHex(fill32("SOL:USDC")) as Hex
        : tokenReady
        ? keccak256(
            encodePacked(
              ["uint256", "address"],
              [parseSafeBigInt(evmChainId), tokenAddress as Address],
            ),
          )
        : ("0x" + "00".repeat(32) as Hex),
    [evmChainId, tokenAddress, tokenReady, isSolana],
  );
  const destinationAssetHash = useMemo(() => {
    if (destinationNetwork.kind === "solana") {
      return toHex(fill32("SOL:USDC")) as Hex;
    }
    return keccak256(
      encodePacked(
        ["uint256", "address"],
        [parseSafeBigInt(destinationNetwork.evmChainId), destinationNetwork.usdc as Address],
      ),
    );
  }, [destinationNetwork]);
  const amountCt = useMemo(() => {
    void tick;
    return randomCt();
  }, [tick]);

  useEffect(() => {
    if (address && recipient === "0x0000000000000000000000000000000000000000") {
      setRecipient(address);
    }
  }, [address, recipient]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FUNDED_INTENTS_KEY);
      setSavedCount(raw ? JSON.parse(raw).length : 0);
    } catch {
      setSavedCount(0);
    }
  }, []);

  useEffect(() => {
    if (!isSolana) return;
    let mounted = true;
    connection.getGenesisHash()
      .then((hash) => {
        if (mounted) setSolanaGenesis(hash);
      })
      .catch((e: any) => {
        if (mounted) setSolanaGenesis(e?.message ?? "failed to read genesis hash");
      });
    return () => {
      mounted = false;
    };
  }, [connection, isSolana]);

  const intent = useMemo<DepositIntent>(() => {
    return {
      version: 1,
      sourceChain: parseSafeInt(sourceChain),
      sourceDomain: parseSafeInt(domain),
      ticker: toBytes(tickerHash, { size: 32 }),
      assetHash: toBytes(assetHash, { size: 32 }),
      epoch: parseSafeBigInt(epoch),
      amountCt,
      intentId: fill32(intentLabel),
    };
  }, [sourceChain, domain, tickerHash, assetHash, epoch, amountCt, intentLabel]);

  const packed = useMemo(() => packDepositIntent(intent), [intent]);
  const { writeContractAsync, isPending } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash ?? undefined });
  const { isLoading: depositConfirming, isSuccess: depositConfirmed } =
    useWaitForTransactionReceipt({
      hash: !isSolana && depositHash ? depositHash as Hex : undefined,
    });

  const balanceQuery = useReadContract({
    abi: ERC20_ABI,
    address: tokenReady ? tokenAddress as Address : undefined,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && tokenReady) },
  });
  const allowanceQuery = useReadContract({
    abi: ERC20_ABI,
    address: tokenReady ? tokenAddress as Address : undefined,
    functionName: "allowance",
    args: address && spokeReady ? [address, spokeAddress as Address] : undefined,
    query: { enabled: Boolean(address && tokenReady && spokeReady) },
  });

  const allowance = allowanceQuery.data ?? 0n;
  const hasAllowance = allowance >= amountRaw && amountRaw > 0n;
  const hasBalance = (balanceQuery.data ?? 0n) >= amountRaw && amountRaw > 0n;
  const canApprove = !isSolana && isConnected && tokenReady && spokeReady && amountRaw > 0n && !isPending;
  const canDeposit =
    !isSolana &&
    isConnected &&
    tokenReady &&
    spokeReady &&
    hasAllowance &&
    hasBalance &&
    amountRaw > 0n &&
    !isPending;
  const onSelectedChain = connectedChainId === parseSafeInt(evmChainId);
  const recipientReady = destinationNetwork.kind === "evm"
    ? isAddress(recipient)
    : recipient.trim().length > 0;
  const setupIssue = isSolana
    ? !solanaWallet.publicKey
      ? "Connect a Solana wallet."
      : destinationNetwork.kind === "evm" && !isAddress(recipient)
        ? "Enter a valid EVM recipient."
      : null
    : !spokeReady
    ? "Set NEXT_PUBLIC_EVM_SPOKE_ADDRESS to the deployed HyperSettleSpoke contract before approving."
    : !isConnected
      ? "Connect an EVM wallet."
      : !onSelectedChain
        ? `Switch wallet to ${network.label}.`
        : amountRaw <= 0n
          ? "Enter an amount greater than 0."
          : destinationNetwork.kind === "evm" && !isAddress(recipient)
            ? "Enter a valid EVM recipient."
          : !hasBalance
            ? "Wallet does not have enough USDC on this network."
            : null;
  const approveDisabled = !canApprove || !onSelectedChain;
  const depositDisabled = !canDeposit || !onSelectedChain || !recipientReady;
  const canSolanaDeposit = isSolana && Boolean(solanaWallet.publicKey) && amountRaw > 0n && recipientReady;

  function saveFundedIntent(txHash: string) {
    const stored = {
      version: 1,
      ticker,
      amount,
      amountRaw: amountRaw.toString(),
      sourceNetworkKey: networkKey,
      sourceNetworkLabel: network.label,
      sourceChain,
      sourceDomain: domain,
      destinationNetworkKey,
      destinationNetworkLabel: destinationNetwork.label,
      destinationChain,
      destinationDomain,
      destinationAssetHash,
      recipient,
      amountCt: toHex(intent.amountCt),
      intentId: toHex(intent.intentId),
      depositTx: txHash,
      createdAt: new Date().toISOString(),
    };
    let existing: unknown[] = [];
    try {
      const raw = window.localStorage.getItem(FUNDED_INTENTS_KEY);
      existing = raw ? JSON.parse(raw) : [];
    } catch {
      existing = [];
    }
    const next = [...existing, stored];
    window.localStorage.setItem(FUNDED_INTENT_KEY, JSON.stringify(stored));
    window.localStorage.setItem(FUNDED_INTENTS_KEY, JSON.stringify(next));
    setSavedCount(next.length);
  }

  async function approveToken() {
    setTxError(null);
    setApproveHash(null);
    try {
      const hash = await writeContractAsync({
        abi: ERC20_ABI,
        address: tokenAddress as Address,
        functionName: "approve",
        args: [spokeAddress as Address, amountRaw],
      });
      setApproveHash(hash);
      await allowanceQuery.refetch();
    } catch (e: any) {
      setTxError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }

  async function submitDeposit() {
    setTxError(null);
    setDepositHash(null);
    try {
      const hash = await writeContractAsync({
        abi: SPOKE_ABI,
        address: spokeAddress as Address,
        functionName: "deposit",
        args: [
          tickerHash,
          assetHash,
          amountRaw,
          toHex(intent.amountCt) as Hex,
          parseSafeBigInt(epoch),
        ],
        value: wormholeFee,
      });
      setDepositHash(hash);
      saveFundedIntent(hash);
      await balanceQuery.refetch();
      await allowanceQuery.refetch();
    } catch (e: any) {
      setTxError(e?.shortMessage ?? e?.message ?? String(e));
    }
  }

  async function submitSolanaDeposit() {
    if (!solanaWallet.publicKey || !solanaWallet.sendTransaction) {
      setTxError("Connect a Solana wallet.");
      return;
    }
    setTxError(null);
    setDepositHash(null);
    try {
      const programId = new PublicKey(SOLANA_SPOKE_PROGRAM);
      const mint = new PublicKey(SOLANA_DEVNET_USDC);
      const tickerBytes = toBytes(tickerHash, { size: 32 });
      const assetBytes = toBytes(assetHash, { size: 32 });
      const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
      const [tickerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("ticker"), Buffer.from(tickerBytes)],
        programId,
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), Buffer.from(tickerBytes)],
        programId,
      );
      const userAta = ataAddress(mint, solanaWallet.publicKey);
      const data = anchorDepositData(
        tickerBytes,
        assetBytes,
        amountRaw,
        intent.amountCt,
        parseSafeBigInt(epoch),
      );
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: solanaWallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPda, isSigner: false, isWritable: true },
          { pubkey: tickerPda, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: userAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(data),
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = solanaWallet.publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const sig = await solanaWallet.sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setDepositHash(sig);
      saveFundedIntent(sig);
    } catch (e: any) {
      setTxError(e?.message ?? String(e));
    }
  }

  const chainGlyph = (key: NetworkKey) => {
    if (key === "solanaDevnet") return <span className="chain-glyph sol">S</span>;
    if (key === "arbitrumSepolia") return <span className="chain-glyph evm-arb">A</span>;
    return <span className="chain-glyph evm-base">B</span>;
  };

  const balanceFormatted =
    !isSolana && balanceQuery.data !== undefined
      ? formatUnits(balanceQuery.data, 6)
      : null;

  function swapDirection() {
    setNetworkKey(destinationNetworkKey);
    setDestinationNetworkKey(networkKey);
  }
  function setMax() {
    if (balanceFormatted) setAmount(balanceFormatted);
  }

  // Staged CTA: a single button that always says exactly what the user
  // needs to do right now.
  let ctaLabel = "Fund intent";
  let ctaAction: (() => void) | null = null;
  let ctaDisabled = true;
  let ctaWarn = false;

  if (isSolana) {
    if (!solanaWallet.publicKey) {
      ctaLabel = "Connect Phantom (top right)";
      ctaWarn = true;
    } else if (!recipientReady) {
      ctaLabel = "Enter a valid recipient";
    } else if (amountRaw <= 0n) {
      ctaLabel = "Enter an amount";
    } else {
      ctaLabel = depositHash ? "Fund another intent" : "Fund intent";
      ctaAction = submitSolanaDeposit;
      ctaDisabled = false;
    }
  } else {
    if (!isConnected) {
      ctaLabel = "Connect wallet (top right)";
      ctaWarn = true;
    } else if (!spokeReady) {
      ctaLabel = "Set NEXT_PUBLIC_EVM_SPOKE_ADDRESS";
      ctaWarn = true;
    } else if (!onSelectedChain) {
      ctaLabel = isSwitchingChain ? "Switching network…" : `Switch to ${network.label}`;
      ctaAction = () => switchChain({ chainId: parseSafeInt(evmChainId) });
      ctaDisabled = isSwitchingChain;
      ctaWarn = true;
    } else if (!recipientReady) {
      ctaLabel = "Enter a valid recipient";
    } else if (amountRaw <= 0n) {
      ctaLabel = "Enter an amount";
    } else if (!hasBalance) {
      ctaLabel = `Insufficient mUSDC on ${network.label}`;
      ctaWarn = true;
    } else if (!hasAllowance) {
      ctaLabel = approveConfirming ? "Approving…" : "Approve mUSDC";
      ctaAction = approveToken;
      ctaDisabled = approveConfirming || !canApprove;
    } else {
      ctaLabel = depositConfirming
        ? "Funding…"
        : depositConfirmed
        ? "Submitted ✓  ·  Fund another"
        : "Fund intent";
      ctaAction = submitDeposit;
      ctaDisabled = depositConfirming || !canDeposit;
    }
  }

  const sourceExplorerLink = !isSolana && depositHash
    ? `https://sepolia.basescan.org/tx/${depositHash}`
    : isSolana && depositHash
    ? `https://explorer.solana.com/tx/${depositHash}?cluster=devnet`
    : null;

  return (
    <div>
      <section className="page-title">
        <div>
          <div className="eyebrow">CROSS-CHAIN INTENT</div>
          <h2>Send USDC across chains by intent</h2>
          <p>
            Deposit on one chain, receive on another. Opposite-direction intents
            cancel — only the difference traverses chains.
          </p>
        </div>
        <span className="conn-pill"><span className="dot" /> Pre-alpha · testnet only</span>
      </section>

      <div className="two-col">
        <section className="panel">
          {/* Route cards */}
          <div className="route-cards">
            <div className="chain-card is-active">
              <div className="ck">From</div>
              <div className="cv">
                {chainGlyph(networkKey)}
                <select
                  value={networkKey}
                  onChange={(e) => setNetworkKey(e.target.value as NetworkKey)}
                  style={{
                    background: "transparent", border: 0, padding: 0,
                    fontWeight: 600, fontSize: 16, color: "var(--text)",
                    marginBottom: 0, cursor: "pointer",
                  }}
                >
                  {Object.entries(NETWORKS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <button
              className="swap-btn"
              onClick={swapDirection}
              title="Swap source ↔ destination"
            >↔</button>
            <div className="chain-card is-active">
              <div className="ck">To</div>
              <div className="cv">
                {chainGlyph(destinationNetworkKey)}
                <select
                  value={destinationNetworkKey}
                  onChange={(e) => setDestinationNetworkKey(e.target.value as NetworkKey)}
                  style={{
                    background: "transparent", border: 0, padding: 0,
                    fontWeight: 600, fontSize: 16, color: "var(--text)",
                    marginBottom: 0, cursor: "pointer",
                  }}
                >
                  {Object.entries(NETWORKS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Amount field */}
          <div className="field">
            <label>You send</label>
            <div className="amount-row">
              <input
                className="amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
              />
              <span className="token-pill">
                {chainGlyph(networkKey)} mUSDC
              </span>
            </div>
            <div className="amount-meta">
              <span>
                {balanceFormatted !== null
                  ? `Balance: ${balanceFormatted} mUSDC`
                  : isSolana
                  ? "Connect Phantom to see balance"
                  : "Connect wallet to see balance"}
              </span>
              {balanceFormatted !== null && (
                <button className="link-btn" onClick={setMax}>MAX</button>
              )}
            </div>
          </div>

          {/* Recipient field */}
          <div className="field">
            <label>Recipient on {destinationNetwork.label}</label>
            <input
              className="address-input"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={destinationNetwork.kind === "evm"
                ? "0x… EVM address"
                : "Base58 Solana address"}
            />
            <div className="amount-meta">
              <span className={recipientReady ? "ok" : "muted"}>
                {recipientReady
                  ? "✓ Recipient looks valid"
                  : `Enter a ${destinationNetwork.kind === "evm" ? "0x… EVM" : "base58 Solana"} address`}
              </span>
              {address && !isSolana && destinationNetwork.kind === "evm" && (
                <button className="link-btn" onClick={() => setRecipient(address)}>
                  USE MY ADDRESS
                </button>
              )}
              {solanaWallet.publicKey && destinationNetwork.kind === "solana" && (
                <button
                  className="link-btn"
                  onClick={() => setRecipient(solanaWallet.publicKey!.toBase58())}
                >USE MY ADDRESS</button>
              )}
            </div>
          </div>

          {/* Staged CTA */}
          <button
            className={`cta${ctaWarn ? " is-warn" : ""}`}
            onClick={ctaAction ?? undefined}
            disabled={ctaDisabled || !ctaAction}
          >
            {ctaLabel}
          </button>

          {txError && (
            <div
              className="notice"
              style={{ borderLeftColor: "var(--bad)", marginTop: 14 }}
            >
              <strong className="err">Transaction failed</strong>
              <div className="code" style={{ marginTop: 6 }}>
                <span className="err">{txError}</span>
              </div>
            </div>
          )}

          {sourceExplorerLink && (
            <div
              className="notice"
              style={{ borderLeftColor: "var(--good)", marginTop: 14 }}
            >
              <strong className="ok">✓ Intent funded</strong>
              <div style={{ marginTop: 4, fontSize: 13 }}>
                <a href={sourceExplorerLink} target="_blank" rel="noreferrer">
                  View transaction →
                </a>
              </div>
            </div>
          )}

          <details className="dev-details">
            <summary>Developer details</summary>
            <div className="kv" style={{ marginTop: 8 }}>
              <div className="k">wallet</div><div>{address ?? solanaWallet.publicKey?.toBase58() ?? "—"}</div>
              <div className="k">USDC mint</div><div>{tokenAddress}</div>
              <div className="k">spoke</div><div>{isSolana ? SOLANA_SPOKE_PROGRAM : (spokeReady ? spokeAddress : "—")}</div>
              <div className="k">epoch</div><div>{epoch}</div>
              <div className="k">batch intents</div><div>{savedCount}</div>
              <div className="k">wormhole fee</div><div>{wormholeFee.toString()} wei</div>
              {!isSolana && allowanceQuery.data !== undefined && (
                <>
                  <div className="k">allowance</div>
                  <div>{formatUnits(allowanceQuery.data, 6)} mUSDC</div>
                </>
              )}
              {approveHash && <><div className="k">approve tx</div><div className="mono">{approveHash}</div></>}
              {depositHash && <><div className="k">deposit tx</div><div className="mono">{depositHash}</div></>}
              <div className="k">intent_id</div><div className="mono">{toHex(intent.intentId)}</div>
              <div className="k">amount_ct</div><div className="mono">{toHex(intent.amountCt)}</div>
              <div className="k">payload</div><div>{packed.length} bytes</div>
            </div>
            <button
              className="secondary"
              style={{ marginTop: 10, fontSize: 11, padding: "4px 10px" }}
              onClick={() => setTick((t) => t + 1)}
            >Regenerate encrypted handle</button>
          </details>
        </section>

        <aside className="panel preview summary-card">
          <h3>Intent summary</h3>

          <div className="route-viz">
            <div className="route-node">
              <span className={
                "glyph-lg " +
                (networkKey === "solanaDevnet" ? "chain-glyph sol"
                  : networkKey === "arbitrumSepolia" ? "chain-glyph evm-arb"
                  : "chain-glyph evm-base")
              }>
                {networkKey === "solanaDevnet" ? "S" : networkKey === "arbitrumSepolia" ? "A" : "B"}
              </span>
              <span className="name">{network.label}</span>
            </div>
            <div className="route-line" />
            <div className="route-node">
              <span className={
                "glyph-lg " +
                (destinationNetworkKey === "solanaDevnet" ? "chain-glyph sol"
                  : destinationNetworkKey === "arbitrumSepolia" ? "chain-glyph evm-arb"
                  : "chain-glyph evm-base")
              }>
                {destinationNetworkKey === "solanaDevnet" ? "S" : destinationNetworkKey === "arbitrumSepolia" ? "A" : "B"}
              </span>
              <span className="name">{destinationNetwork.label}</span>
            </div>
          </div>

          <div className="summary-row">
            <span className="sl">You send</span>
            <span className="sv">{amount || "0"} mUSDC</span>
          </div>
          <div className="summary-row">
            <span className="sl">You receive</span>
            <span className="sv">{amount || "0"} mUSDC</span>
          </div>
          <div className="summary-row">
            <span className="sl">Recipient</span>
            <span className="sv mono">
              {recipientReady
                ? recipient.length > 16
                  ? `${recipient.slice(0, 8)}…${recipient.slice(-6)}`
                  : recipient
                : "—"}
            </span>
          </div>
          <div className="summary-row">
            <span className="sl">Network fee</span>
            <span className="sv">testnet · &lt; $0.01</span>
          </div>
          <div className="summary-row">
            <span className="sl">ETA after netting</span>
            <span className="sv">~30s once both legs deposit</span>
          </div>
          <div className="summary-row">
            <span className="sl">Privacy</span>
            <span className="sv">amount encrypted on hub</span>
          </div>
          <div className="summary-row">
            <span className="sl">In this browser batch</span>
            <span className="sv">{savedCount} funded intent{savedCount === 1 ? "" : "s"}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
