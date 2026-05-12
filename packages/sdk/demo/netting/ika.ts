// Thin wrapper around @ika.xyz/pre-alpha-solana-client.
//
// Exposes:
//   - ikaDkg(sender) → real ed25519 pubkey from the Ika network
//   - ikaTrySign(...) → best-effort signature; returns null + the error
//     message on any failure (the published gRPC-Web client v0.1.1 hardcodes
//     a zero dwallet_attestation in requestSign, which the live pre-alpha
//     rejects with "failed to decode dwallet_attestation"; real MPC also
//     not online yet)
//
// The intent is to use the official SDK rather than re-implement the protocol
// while being honest about what currently works on pre-alpha.

import { createIkaWebClient } from "@ika.xyz/pre-alpha-solana-client/grpc-web";

export const IKA_BASE_URL =
  process.env.IKA_BASE_URL ?? "https://pre-alpha-dev-1.ika.ika-network.net:443";

export interface IkaDkgResult {
  publicKey: Uint8Array; // 32-byte ed25519 pubkey
  dwalletAddr: Uint8Array; // currently 32 zeros on pre-alpha (placeholder)
  endpoint: string;
  elapsedMs: number;
}

export async function ikaDkg(sender: Uint8Array): Promise<IkaDkgResult> {
  const client = createIkaWebClient(IKA_BASE_URL);
  const t0 = Date.now();
  const res = await client.requestDKG(sender);
  return {
    publicKey: res.publicKey,
    dwalletAddr: res.dwalletAddr,
    endpoint: IKA_BASE_URL,
    elapsedMs: Date.now() - t0,
  };
}

export interface IkaSignResult {
  ok: boolean;
  signature: Uint8Array | null;
  error: string | null;
  elapsedMs: number;
}

export async function ikaTrySign(
  sender: Uint8Array,
  dwalletAddr: Uint8Array,
  message: Uint8Array,
): Promise<IkaSignResult> {
  const client = createIkaWebClient(IKA_BASE_URL);
  const t0 = Date.now();
  try {
    const sig = await client.requestSign(
      sender,
      dwalletAddr,
      message,
      new Uint8Array(32), // presignId placeholder
      new Uint8Array(64), // txSignature placeholder
    );
    return { ok: true, signature: sig, error: null, elapsedMs: Date.now() - t0 };
  } catch (e: any) {
    return {
      ok: false,
      signature: null,
      error: e?.message ?? String(e),
      elapsedMs: Date.now() - t0,
    };
  }
}
