# hypersettle-evm-spoke

Foundry project — HyperSettle Solidity spoke.

Deploys to any EVM chain. Users `deposit` tokens and create `invoice` intents via Wormhole VAAs; the hub settles via an Ika-signed `executeSettlement` call.

Build: `forge build` — Test: `forge test`.

See `../../docs/ARCHITECTURE.md`.
