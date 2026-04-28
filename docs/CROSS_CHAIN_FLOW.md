# Cross-Chain Flow

Three sequences matter: deposit, invoice, settlement. Each crosses at least one chain boundary.

## Deposit flow

```
User            EVM Spoke        Wormhole        Hub (Solana)      Encrypt
 │                │                │                │                │
 │ approve(token) │                │                │                │
 ├───────────────►│                │                │                │
 │                │                │                │                │
 │ encrypt amount client-side via encrypt-client    │                │
 │ (produces: encrypted_handle, proof)              │                │
 │                │                │                │                │
 │ deposit(token, handle, proof, destDomain, recipient)              │
 ├───────────────►│                │                │                │
 │                │ transferFrom(user → spoke)      │                │
 │                │ build DepositIntent payload     │                │
 │                │ publishMessage(vaa)             │                │
 │                ├───────────────►│                │                │
 │                │                │ guardians sign │                │
 │                │                ├───────────────►│                │
 │                │                │                │ receive_deposit(vaa)
 │                │                │                ├───────────────►│
 │                │                │                │ store ciphertext ref
 │                │                │                │◄───────────────┤
 │                │                │                │ update deposits[epoch][domain][ticker]
 │                │                │                │                │
```

Hub state change: new `Deposit` PDA with `(epoch, domain, ticker, encrypted_amount_ref)`.

## Invoice flow

```
User            EVM Spoke        Wormhole        Hub (Solana)      Encrypt
 │                │                │                │                │
 │ encrypt amount client-side                       │                │
 │                │                │                │                │
 │ invoice(ticker, handle, proof, recipientChain, recipient)         │
 ├───────────────►│                │                │                │
 │                │ publishMessage(vaa)             │                │
 │                ├───────────────►├───────────────►│                │
 │                │                │                │ receive_invoice(vaa)
 │                │                │                │ match_invoice(ciphertext refs)
 │                │                │                ├───────────────►│
 │                │                │                │  runs #[encrypt_fn] netting DAG
 │                │                │                │◄───────────────┤
 │                │                │                │  output: encrypted settlement_amount
 │                │                │                │                │
```

Matching runs synchronously inside the hub transaction. The loop is fixed-bounded and branchless, per blueprint Mental Models 2 and 5.

## Settlement flow

```
Hub (Solana)       Encrypt         Ika           Relayer       Dest Spoke
 │                  │               │              │              │
 │ request_decrypt(settlement_ref)  │              │              │
 ├─────────────────►│               │              │              │
 │                  │ authorized?   │              │              │
 │◄─────────────────┤ plaintext u64 │              │              │
 │                  │               │              │              │
 │ build SettlementOrder (plaintext amount, recipient, dest, nonce)
 │ approve_message(order_bytes)     │              │              │
 ├──────────────────────────────────►│              │              │
 │                  │               │ validators   │              │
 │                  │               │ sign (ECDSA  │              │
 │                  │               │ or ed25519)  │              │
 │                  │               │ → signature  │              │
 │                  │               │   PDA        │              │
 │                  │               │              │              │
 │                  │               │ watch event  │              │
 │                  │               │◄─────────────┤              │
 │                  │               │              │ executeSettlement(order, sig)
 │                  │               │              ├─────────────►│
 │                  │               │              │              │ verify sig vs dWallet pubkey
 │                  │               │              │              │ transfer(token, amount, recipient)
 │                  │               │              │              │
```

Key invariant: the plaintext `amount` only appears in a single frame — from when Encrypt reveals it to when the hub calls `approve_message`. The spoke never sees the ciphertext; it only sees the already-plaintext order plus an Ika signature.

## Failure modes

- **VAA replay.** Each VAA carries a sequence number checked on the hub.
- **Settlement replay.** Each `SettlementOrder` carries a nonce; the spoke tracks consumed nonces per dWallet.
- **Decryption stall.** If Encrypt does not return plaintext, the hub cannot call `approve_message`. A settlement stuck in this state blocks `custodied` funds until Encrypt recovers.
- **Ika stall.** If Ika validators do not sign, the relayer cannot submit. Same freeze, different layer.
