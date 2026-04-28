# HyperSettle on Solana

Hub-and-spoke netting engine with encrypted amounts and bridgeless cross-chain settlement.

- **Hub:** Solana program (Anchor v1) running FHE netting via [Encrypt](https://docs.encrypt.xyz/). Calls Ika's `approve_message` CPI to request a dWallet signature on the destination chain.
- **Spokes:** Solidity contracts on EVM chains + an Anchor program for Solana. Custody real tokens; only execute settlements signed by the registered Ika dWallet.
- **Inbound messaging:** Wormhole VAAs carry encrypted intent handles from spokes to the hub. Phase 5 standardised the on-wire format; live Wormhole Core integration is queued for a future phase.
- **Outbound settlement:** [Ika](https://docs.ika.xyz/) dWallets (2PC-MPC threshold signatures) sign destination-chain transactions directly. No bridges, no wrapping.

## Status

This is a working multi-package prototype. All packages build, all in-scope tests pass:

| Package | Build | Tests |
|---|---|---|
| `packages/hub` (Anchor v1, Solana) | `anchor build` ✅ | `anchor test` 6/6 ✅ + 4 `it.skip` (Encrypt/Ika devnet-only) |
| `packages/evm-spoke` (Foundry) | `forge build` ✅ | `forge test` 13/13 ✅ |
| `packages/solana-spoke` (Anchor v1) | `anchor build` ✅ | `anchor test` 8/8 ✅ |
| `packages/sdk` (TypeScript) | `pnpm build` ✅ | `pnpm demo` ✅ end-to-end |

Both Encrypt and Ika are pre-alpha (mock crypto in their pre-alpha pipelines). The hub builds against the real SDK surface; the underlying crypto maturity is the SDK's responsibility.

## Run it

Prereqs: `anchor 1.0.0` (`avm install 1.0.0 && avm use 1.0.0`), `solana 3.0.13`, `cargo-build-sbf` platform-tools `v1.54`, `forge 1.4`, `pnpm 10.x`, `node 20+`.

```sh
# from repo root
pnpm install

# Hub (Solana program with FHE matching + Ika CPI)
pnpm --filter ./packages/hub exec anchor test

# EVM spoke (Solidity)
forge test --root packages/evm-spoke

# Solana spoke (SPL custody + ed25519 ika auth)
pnpm --filter ./packages/solana-spoke exec anchor test

# End-to-end SDK demo: pack intents + settlement order, sign with mock Ika, verify ECDSA recovery
pnpm --filter ./packages/sdk run demo
```

## Layout

```
hypersettle.sol/
├── PLAN.md                      phased implementation plan
├── ACTIONS.md                   running log of every action taken
├── docs/                        long-form architecture / flow / FHE explainers
└── packages/
    ├── hub/                     Anchor: matching hub (Encrypt FHE + Ika CPI)
    ├── evm-spoke/               Foundry: Solidity spoke (custody + executeSettlement)
    ├── solana-spoke/            Anchor: SPL spoke (ed25519 ika verification)
    ├── shared/messages.md       canonical wire format spec (143/145/153 bytes)
    └── sdk/                     TypeScript: pack helpers + relayer + demo
```

## Architecture in one paragraph

Users `deposit` plaintext tokens on a spoke and post a Wormhole VAA carrying an Encrypt ciphertext-pubkey handle for the encrypted amount. The Solana hub consumes that VAA, stores the handle in a per-`(ticker, epoch, domain)` deposit bucket, and runs an FHE matching graph (`#[encrypt_fn] match_slot_graph`, `settle_graph`) when an invoice arrives — entirely in the encrypted domain. Once the settlement amount is finalized, the hub calls Ika `approve_message` so a dWallet signs the canonical `SettlementOrder` bytes; an off-chain relayer fetches the signature and submits to the destination spoke's `executeSettlement`. The spoke verifies (`ecrecover` for EVM, ed25519 precompile for Solana) and transfers tokens. The hub never sees plaintext amounts; the spokes never see ciphertexts.

## Reading order

1. `HYPERSETTLE_BLUEPRINT.md` (one directory up) — stack-agnostic conceptual model.
2. `docs/ARCHITECTURE.md` — components + trust boundaries.
3. `docs/CROSS_CHAIN_FLOW.md` — sequence diagrams.
4. `docs/FHE_NETTING.md` — the Encrypt graphs.
5. `packages/shared/messages.md` — wire format (the contract between languages).
6. `ACTIONS.md` — chronological log if you want to see how it was built.
