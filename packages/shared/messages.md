# Cross-Component Message Schemas

Three canonical payloads travel between components. Amounts are never
transmitted in plaintext except in the `SettlementOrder` (post-reveal, by
design).

## Wire format

**Big-endian packed bytes.** Fields are concatenated back-to-back, no
padding, integers serialized big-endian. Both the EVM spoke
(`abi.encodePacked`) and the Solana hub (custom parser in
`state/messages.rs::parse_*_packed`) implement this format directly. Neither
Borsh nor Solidity's default `abi.encode` are used on the wire because they
don't interoperate.

Authoritative definitions:
- **EVM**: `packages/evm-spoke/src/libs/Messages.sol` — `packDepositIntent`,
  `packInvoiceIntent`, `packSettlementOrder`.
- **Solana hub**: `packages/hub/programs/hypersettle-hub/src/state/messages.rs` —
  `parse_deposit_intent_packed`, `parse_invoice_intent_packed`.
- **Solana spoke (outbound)**: to be added alongside the Wormhole CPI in a
  later phase; format identical.

## 1. `DepositIntent` (spoke → hub) — 143 bytes

| Offset | Size | Field | Type | Notes |
|---:|---:|---|---|---|
| 0  | 1  | `version` | `u8` | 1 |
| 1  | 2  | `source_chain` | `u16 BE` | Wormhole chain id |
| 3  | 4  | `source_domain` | `u32 BE` | HyperSettle internal domain |
| 7  | 32 | `ticker` | `bytes32` | `keccak256(symbol)` |
| 39 | 32 | `asset_hash` | `bytes32` | `keccak256(chain_id, token)` |
| 71 | 8  | `epoch` | `u64 BE` | |
| 79 | 32 | `amount_ct` | `bytes32` | Encrypt ciphertext pubkey |
| 111| 32 | `intent_id` | `bytes32` | Idempotency key |

## 2. `InvoiceIntent` (spoke → hub) — 145 bytes

| Offset | Size | Field | Type | Notes |
|---:|---:|---|---|---|
| 0   | 1  | `version` | `u8` | |
| 1   | 2  | `source_chain` | `u16 BE` | |
| 3   | 4  | `source_domain` | `u32 BE` | |
| 7   | 32 | `ticker` | `bytes32` | |
| 39  | 8  | `epoch` | `u64 BE` | |
| 47  | 32 | `amount_ct` | `bytes32` | |
| 79  | 2  | `recipient_chain` | `u16 BE` | |
| 81  | 32 | `recipient` | `bytes32` | Address padded left to 32 bytes for EVM |
| 113 | 32 | `intent_id` | `bytes32` | |

## 3. `SettlementOrder` (hub → Ika → spoke) — 153 bytes

| Offset | Size | Field | Type | Notes |
|---:|---:|---|---|---|
| 0   | 1  | `version` | `u8` | |
| 1   | 2  | `source_chain` | `u16 BE` | Hub chain id |
| 3   | 2  | `dest_chain` | `u16 BE` | |
| 5   | 4  | `dest_domain` | `u32 BE` | |
| 9   | 32 | `ticker` | `bytes32` | |
| 41  | 32 | `asset_hash` | `bytes32` | |
| 73  | 8  | `amount` | `u64 BE` | Plaintext, post-reveal |
| 81  | 32 | `recipient` | `bytes32` | |
| 113 | 32 | `intent_id` | `bytes32` | |
| 145 | 8  | `nonce` | `u64 BE` | Per-dWallet monotonic |

Signature format:

- **EVM destination**: `ecrecover`-compatible ECDSA over
  `keccak256("\x19Ethereum Signed Message:\n32", keccak256(packSettlementOrder(order)))`
  — see `Messages.settlementDigest` in `packages/evm-spoke/src/libs/Messages.sol`.
- **Solana destination**: ed25519 over `borsh_serialize(order)` (Solana spoke
  uses Borsh because the ed25519 precompile signs raw message bytes and
  Borsh is the native serializer; the Solana hub signs as-is via an Ika
  dWallet ed25519 key, distinct from the Solana address format).

## Why hand-packed and not Borsh or ABI

- **Borsh** on EVM requires writing a Borsh encoder in Solidity — not
  available off-the-shelf.
- **Solidity ABI** (`abi.encode`) includes 32-byte alignment and tuple head
  pointers that don't match Borsh's flat layout.
- **Hand-packed big-endian** is trivially implementable in both languages
  (`abi.encodePacked` on EVM, a `u*::from_be_bytes` reader on Solana).

Per blueprint MM1, only amounts are encrypted. All fields above that aren't
`amount_ct` / `amount` are plaintext identifiers, time coordinates, or
routing info — required to stay plaintext so the hub can use them as map
keys, loop bounds, and destination addresses.
