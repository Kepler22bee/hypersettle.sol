# hypersettle-shared

Cross-language contracts between components. The source of truth for on-wire message layouts.

- `messages.md` — human-readable schema definitions for `DepositIntent`, `InvoiceIntent`, and `SettlementOrder`.
- `schemas/` — JSON Schemas (generated from the authoritative Rust/Solidity definitions in Phase 1+).

The authoritative struct definitions live in:
- `packages/hub/programs/hypersettle-hub/src/state/messages.rs` (Rust / Borsh)
- `packages/evm-spoke/src/libs/Messages.sol` (Solidity / ABI)

This package is documentation only; it produces no build artifacts.
