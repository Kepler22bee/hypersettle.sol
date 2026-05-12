# Testnet netting demo — Base Sepolia + Solana Devnet

End-to-end netting of opposite-direction USDC intents across real testnets. Deposits and unlocks are on-chain. DKG hits the live Ika pre-alpha network. Tokens actually move.

## What it does

```
User A:  1.01 mUSDC on Base Sepolia       (destination = Solana)
User B:  1.00 mUSDC on Solana Devnet      (destination = Base)

Netted:  matched 1.00 / surplus 0.01      (direction: base → solana)

Unlock:  user A receives 1.01 mUSDC on Solana
         user B receives 1.00 mUSDC on Base

After:   EVM  vault   5.01 mUSDC  (+0.01 surplus)
         SOL  vault   4.99 mUSDC  (-0.01 deficit)
         only 0.01 needs to actually traverse chains
```

Amounts are scaled down vs the local demo because vault liquidity is bounded by what we mint at deploy (5 mUSDC per side). Scale up freely — `MockUSDC.mint` is open.

## Prerequisites

- `node` 18+, `pnpm`, `forge`, `anchor`, `solana` CLIs on PATH.
- Funded operator keypairs (generate + fund once; saved under `.netting-testnet/`, gitignored).

## Setup

```bash
# 1. Generate operator keypairs (only first time)
pnpm demo:netting:testnet:init

# Prints two addresses — fund both:
#   Base Sepolia ETH (~0.05) for gas
#   Solana Devnet SOL (~3) for program deploy + SPL ops
# See https://www.alchemy.com/faucets/base-sepolia
# And `solana airdrop 2 <addr> --url devnet`

# 2. EVM deploy: MockUSDC + HyperSettleSpoke + bindTicker + mint liquidity
pnpm demo:netting:testnet:deploy:evm

# 3. Solana program deploy (one-time, ~2 SOL). Skip if already done.
cd packages/solana-spoke
solana-keygen new -o target/deploy/hypersettle_spoke-keypair.json --force --no-bip39-passphrase
anchor keys sync
anchor build
anchor deploy --provider.cluster devnet \
  --provider.wallet ../../.netting-testnet/operator-sol.json
cd -

# 4. Solana init: initialize config + create SPL mint + bind ticker + mint liquidity
pnpm demo:netting:testnet:deploy:sol
```

## Run the demo

```bash
# Terminal 1
pnpm demo:netting:testnet

# Terminal 2 (in another window)
pnpm frontend:dev

# Browser
open http://localhost:3000/netting
```

The orchestrator pauses ~4s between phases so the `/netting` page can show progress live. It stays alive after Done — Ctrl-C to shut down.

## Outputs

- Deploy artifacts in `.netting-testnet/evm.json` and `.netting-testnet/sol.json` (gitignored). These persist between runs; the demo just reads them.
- Live state on `http://localhost:7070/state` (consumed by the frontend).
- Tx hashes printed in the console link to:
  - https://sepolia.basescan.org/tx/<hash>
  - https://explorer.solana.com/tx/<sig>?cluster=devnet

## Caveats

- **Ika MPC sign is mock on pre-alpha.** The demo calls `requestSign` for honesty but falls back to a local ed25519 stand-in (saved alongside the Solana state) for the actual unlock, because the published SDK v0.1.1 doesn't thread the DKG attestation through. The spoke is initialized with that stand-in pubkey.
- **No Ika ECDSA pre-alpha SDK exists yet** — the EVM `ikaDWallet` is a fresh secp256k1 key we generate at deploy.
- **Wormhole VAA transport not consumed.** The spoke's `deposit` calls publish to real Base Sepolia Wormhole (~no fee on testnet) but no hub program is listening. The netting math is done off-chain by the orchestrator. The full hub-side FHE matching is still gated on Encrypt + Ika devnet maturity.
- **Public RPCs can lag.** The runner retries balance reads for a few seconds after each unlock to ride out stale-read windows.
