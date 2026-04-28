# Architecture

This document is the long-form counterpart to the one-page summary in `README.md`. It describes the three runtime components, the two message lanes connecting them, and the trust boundaries.

## Components

### 1. Hub (`packages/hub`)

An Anchor program deployed to Solana. Responsibilities:

- Accept inbound Wormhole VAAs from EVM and Solana spokes and persist the encrypted deposit / invoice intents they carry.
- Run the netting matching algorithm as a `#[encrypt_fn]` DAG — all amount arithmetic is branchless and fixed-loop.
- Request decryption of the final settlement amount from the Encrypt network.
- Call Ika `approve_message` CPI to have the Ika dWallet sign the outbound settlement payload for the destination chain.

The hub is the only component that touches encrypted state. Spokes deal exclusively with plaintext tokens.

### 2. EVM Spoke (`packages/evm-spoke`)

A Solidity contract deployed to each EVM chain that participates (Arbitrum, Base, etc.).

- `deposit(token, encryptedAmount, proof, destDomain, recipient)` — custodies tokens, posts a `DepositIntent` VAA via Wormhole.
- `invoice(ticker, encryptedAmount, proof, recipientChain, recipient)` — posts an `InvoiceIntent` VAA.
- `executeSettlement(SettlementOrder, ikaSignature)` — verifies an ECDSA signature against the registered Ika dWallet public key and transfers tokens to the recipient.

The spoke does not understand FHE. The encrypted amount is produced client-side (via the Encrypt SDK) and passed through as an opaque byte string.

### 3. Solana Spoke (`packages/solana-spoke`)

An Anchor program mirroring the EVM spoke's responsibilities on Solana. Signature verification uses ed25519 instead of ECDSA, reflecting the Ika dWallet curve for Solana-targeted signing.

## Message lanes

### Lane A — inbound (spokes → hub)

Transport: Wormhole. Each deposit and invoice is a VAA whose payload is a `DepositIntent` or `InvoiceIntent` struct (Borsh-encoded on Solana, ABI-encoded on EVM; mapped 1:1 via `packages/shared/messages.md`). The hub's `receive_deposit` and `receive_invoice` instructions consume the VAA via the Wormhole Solana program.

### Lane B — outbound (hub → spokes)

Transport: off-chain relayer + Ika signature. After the hub decrypts the settlement amount, it calls `ika::approve_message` on the Solana Ika pre-alpha program with the `SettlementOrder` bytes. Ika validators produce a signature (ECDSA for EVM destinations, ed25519 for Solana destination) and write it to a PDA. A relayer reads the signature account and submits a transaction to `executeSettlement` on the destination spoke.

No bridge is required because the Ika dWallet is the authorized signer on every destination chain. The relayer only transports bytes; it cannot forge settlements.

## Trust boundaries

| Trust assumption | Component |
|---|---|
| Solana validators honestly execute the hub program | Solana L1 |
| Encrypt executors faithfully evaluate the `#[encrypt_fn]` DAG | Encrypt |
| Encrypt decryptors honestly reveal plaintext only on authorized request | Encrypt |
| Ika validators only sign messages approved by the hub PDA | Ika network |
| Wormhole guardians honestly sign VAAs | Wormhole |
| Each spoke recognizes the correct Ika dWallet public key | deployment config |

Weakening any one layer breaks a specific security property; the system is as strong as the weakest of them.

## Non-goals

- **Ordering guarantees across spokes.** Wormhole gives eventual delivery, not total order. Epoch bucketing on the hub handles ordering.
- **MEV resistance.** Public ciphertext arrival times leak activity volume even when amounts stay private. Addressed in the blueprint as a known failure mode.
- **Recovery without Ika liveness.** If Ika validators go offline, settlements freeze. The blueprint calls this out as "Decryption availability".
