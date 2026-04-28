// Off-chain relayer that watches the hub for SettlementDispatched events,
// fetches the Ika dWallet signature, and submits to the destination spoke.
//
// In production: the relayer connects to the Ika network's gRPC endpoint
// and retrieves the signature account written by the Ika validators after
// `approve_message` was invoked on the hub.
//
// For this prototype: the relayer holds a local secp256k1 / ed25519 key
// that mirrors the dWallet's authority — the signature it produces is what
// the destination spoke would have received from the real Ika network.

import { keccak256 } from "viem";
import { type SettlementOrder, packSettlementOrder, SignatureScheme } from "./messages.js";

export interface IkaSignerLike {
  /// Returns a signature over `digest` using the dWallet's private key.
  signEvmDigest(digest: Uint8Array): Promise<Uint8Array>;
  signSolanaMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface SettlementBundle {
  order: SettlementOrder;
  /// Signature ready to submit to the destination spoke. For EVM this is
  /// 65 bytes (r||s||v); for Solana it's 64 bytes (ed25519 detached).
  signature: Uint8Array;
}

/// Compute the EIP-191 prefixed digest that an EVM spoke verifies via
/// `Messages.settlementDigest`.
export function evmSettlementDigest(order: SettlementOrder): Uint8Array {
  const packed = packSettlementOrder(order);
  const inner = keccak256(packed);
  // EIP-191 prefix
  const prefix = Buffer.from("\x19Ethereum Signed Message:\n32", "binary");
  return Buffer.from(
    keccak256(Buffer.concat([prefix, Buffer.from(inner.slice(2), "hex")])).slice(2),
    "hex",
  );
}

/// Build a signed bundle ready to submit to the destination spoke.
export async function buildSettlementBundle(
  signer: IkaSignerLike,
  order: SettlementOrder,
): Promise<SettlementBundle> {
  if (order.destDomain === 0) throw new Error("dest domain unset");

  if (isEvmDestination(order.destChain)) {
    const digest = evmSettlementDigest(order);
    const signature = await signer.signEvmDigest(digest);
    return { order, signature };
  }
  // Solana destination: ed25519 over packed bytes.
  const message = packSettlementOrder(order);
  const signature = await signer.signSolanaMessage(message);
  return { order, signature };
}

function isEvmDestination(chain: number): boolean {
  // Wormhole EVM chain ids (subset). 0 means unknown -> default to EVM.
  return ![1, 0].includes(chain) /* Solana = 1 in our hub config */;
}

export const SettlementSchemeFor = {
  evm: SignatureScheme.Secp256k1,
  solana: SignatureScheme.Ed25519,
};
