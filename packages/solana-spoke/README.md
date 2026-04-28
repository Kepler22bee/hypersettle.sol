# hypersettle-solana-spoke

Anchor program (Solana) — HyperSettle Solana spoke.

Mirrors the EVM spoke's interface: `deposit`, `invoice`, `execute_settlement`. Signature verification uses ed25519 (the Ika dWallet curve for Solana destinations).

Build: `anchor build` — Test: `anchor test`.

See `../../docs/ARCHITECTURE.md`.
