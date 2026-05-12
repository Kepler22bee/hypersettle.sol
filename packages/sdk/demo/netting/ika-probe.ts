// Probe the official @ika.xyz/pre-alpha-solana-client over gRPC-Web from Node.
// The native gRPC entry hits a 403 (the public endpoint expects gRPC-Web).
import { createIkaWebClient } from "@ika.xyz/pre-alpha-solana-client/grpc-web";

const IKA_BASE_URL =
  process.env.IKA_BASE_URL ?? "https://solana-pre-alpha.ika.xyz";

function fill32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(Buffer.from(label).slice(0, 32));
  return out;
}
function hex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}

async function main() {
  console.log("Endpoint:", IKA_BASE_URL);
  const client = createIkaWebClient(IKA_BASE_URL);
  const sender = fill32("hypersettle-netting-demo");

  console.log("\n--- DKG (Curve25519/EdDSA — Solana destination) ---");
  const t0 = Date.now();
  const dkg = await client.requestDKG(sender);
  console.log(`  pubkey      : ${hex(dkg.publicKey)} (${dkg.publicKey.length} bytes)`);
  console.log(`  dwalletAddr : ${hex(dkg.dwalletAddr)}`);
  console.log(`  elapsed     : ${Date.now() - t0}ms`);

  console.log("\n--- Sign ---");
  const t1 = Date.now();
  const sig = await client.requestSign(
    sender,
    dkg.publicKey,
    fill32("test-message"),
    new Uint8Array(32),
    new Uint8Array(64),
  );
  console.log(`  signature : ${hex(sig)} (${sig.length} bytes)`);
  console.log(`  is-zeros  : ${sig.every((b) => b === 0) ? "YES (mock)" : "NO (real)"}`);
  console.log(`  elapsed   : ${Date.now() - t1}ms`);
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
