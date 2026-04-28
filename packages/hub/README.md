# hypersettle-hub

Anchor program (Solana) — HyperSettle netting hub.

- Consumes Wormhole VAAs from spokes.
- Runs FHE matching via Encrypt (`#[encrypt_fn]`).
- Requests decryption and dispatches Ika-signed settlements.

Build: `anchor build` — Test: `anchor test`.

See `../../docs/ARCHITECTURE.md` and `../../docs/FHE_NETTING.md`.
