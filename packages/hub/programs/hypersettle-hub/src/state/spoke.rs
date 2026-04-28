use anchor_lang::prelude::*;

/// A registered spoke emitter. Keyed by `(chain, emitter_address)` — the
/// Wormhole chain id plus the 32-byte emitter (left-padded EVM address or
/// Solana program id). Creates the inbound authorization set for
/// `receive_deposit_from_vaa` / `receive_invoice_from_vaa`.
#[account]
#[derive(InitSpace)]
pub struct RegisteredSpoke {
    pub chain: u16,
    pub emitter: [u8; 32],
    pub domain: u32,
    pub bump: u8,
}
