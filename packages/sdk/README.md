# @hypersettle/sdk

TypeScript client SDK — drives the Solana hub, EVM spokes, and Solana spoke end-to-end.

Build: `pnpm build` — Demo: `pnpm demo`.

Wraps:
- `encrypt-client` for encrypting amounts before dispatch.
- `@ika.xyz/sdk` for dWallet and signature orchestration.
- Wormhole SDK for VAA construction and relay.
- `viem` for EVM spoke calls.
- `@solana/web3.js` + Anchor generated clients for Solana.

See `../../docs/ARCHITECTURE.md`.
