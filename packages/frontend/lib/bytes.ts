// Browser-safe helpers for filling 32-byte handles and rendering hex.

export function fill32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  const enc = new TextEncoder().encode(label);
  out.set(enc.slice(0, 32));
  return out;
}

export function paddedAddr(addr: `0x${string}`): Uint8Array {
  const out = new Uint8Array(32);
  const hex = addr.slice(2);
  for (let i = 0; i < 20; i++) {
    out[12 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toHex(bytes: Uint8Array | Buffer | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  let s = "0x";
  for (let i = 0; i < u8.length; i++) {
    s += u8[i].toString(16).padStart(2, "0");
  }
  return s;
}

export function randomCt(): Uint8Array {
  // Stand-in for an Encrypt ciphertext-account pubkey. In a real flow this
  // would come from `client.create_input::<Uint64>(amount, ...)` over gRPC.
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

export function keccak256Buffer(input: Uint8Array): Uint8Array {
  // Lazy keccak: import from viem at the call site to avoid pulling viem here.
  throw new Error("use viem.keccak256 directly");
}
