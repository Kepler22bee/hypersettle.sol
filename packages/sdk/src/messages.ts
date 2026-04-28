// Cross-chain wire format helpers (mirrors packages/shared/messages.md and
// packages/evm-spoke/src/libs/Messages.sol).

export const INTENT_VERSION = 1;

export const DEPOSIT_INTENT_PACKED_LEN = 143;
export const INVOICE_INTENT_PACKED_LEN = 145;
export const SETTLEMENT_ORDER_PACKED_LEN = 153;

export interface DepositIntent {
  version: number;
  sourceChain: number;
  sourceDomain: number;
  ticker: Uint8Array;
  assetHash: Uint8Array;
  epoch: bigint;
  amountCt: Uint8Array;
  intentId: Uint8Array;
}

export interface InvoiceIntent {
  version: number;
  sourceChain: number;
  sourceDomain: number;
  ticker: Uint8Array;
  epoch: bigint;
  amountCt: Uint8Array;
  recipientChain: number;
  recipient: Uint8Array;
  intentId: Uint8Array;
}

export interface SettlementOrder {
  version: number;
  sourceChain: number;
  destChain: number;
  destDomain: number;
  ticker: Uint8Array;
  assetHash: Uint8Array;
  amount: bigint;
  recipient: Uint8Array;
  intentId: Uint8Array;
  nonce: bigint;
}

const enc = (
  buf: Buffer,
  off: number,
  fn: (b: Buffer, o: number) => void,
): number => {
  fn(buf, off);
  return off;
};

function copy(src: Uint8Array, dst: Buffer, off: number, len: number) {
  if (src.length !== len) throw new Error(`expected ${len} bytes, got ${src.length}`);
  dst.set(src, off);
}

export function packDepositIntent(i: DepositIntent): Buffer {
  const buf = Buffer.alloc(DEPOSIT_INTENT_PACKED_LEN);
  let o = 0;
  buf.writeUInt8(i.version, o); o += 1;
  buf.writeUInt16BE(i.sourceChain, o); o += 2;
  buf.writeUInt32BE(i.sourceDomain, o); o += 4;
  copy(i.ticker, buf, o, 32); o += 32;
  copy(i.assetHash, buf, o, 32); o += 32;
  buf.writeBigUInt64BE(i.epoch, o); o += 8;
  copy(i.amountCt, buf, o, 32); o += 32;
  copy(i.intentId, buf, o, 32); o += 32;
  return buf;
}

export function packInvoiceIntent(i: InvoiceIntent): Buffer {
  const buf = Buffer.alloc(INVOICE_INTENT_PACKED_LEN);
  let o = 0;
  buf.writeUInt8(i.version, o); o += 1;
  buf.writeUInt16BE(i.sourceChain, o); o += 2;
  buf.writeUInt32BE(i.sourceDomain, o); o += 4;
  copy(i.ticker, buf, o, 32); o += 32;
  buf.writeBigUInt64BE(i.epoch, o); o += 8;
  copy(i.amountCt, buf, o, 32); o += 32;
  buf.writeUInt16BE(i.recipientChain, o); o += 2;
  copy(i.recipient, buf, o, 32); o += 32;
  copy(i.intentId, buf, o, 32); o += 32;
  return buf;
}

export function packSettlementOrder(o: SettlementOrder): Buffer {
  const buf = Buffer.alloc(SETTLEMENT_ORDER_PACKED_LEN);
  let off = 0;
  buf.writeUInt8(o.version, off); off += 1;
  buf.writeUInt16BE(o.sourceChain, off); off += 2;
  buf.writeUInt16BE(o.destChain, off); off += 2;
  buf.writeUInt32BE(o.destDomain, off); off += 4;
  copy(o.ticker, buf, off, 32); off += 32;
  copy(o.assetHash, buf, off, 32); off += 32;
  buf.writeBigUInt64BE(o.amount, off); off += 8;
  copy(o.recipient, buf, off, 32); off += 32;
  copy(o.intentId, buf, off, 32); off += 32;
  buf.writeBigUInt64BE(o.nonce, off); off += 8;
  return buf;
}

export const SignatureScheme = {
  Secp256k1: 1, // EVM destinations
  Ed25519: 2,   // Solana destinations
} as const;
