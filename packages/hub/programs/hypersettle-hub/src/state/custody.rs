use anchor_lang::prelude::*;

/// Encrypted custody claim on one (chain, asset) pair. `balance_ct` points to
/// an Encrypt ciphertext account holding the running u64 balance.
#[account]
#[derive(InitSpace)]
pub struct CustodyLedger {
    pub asset_hash: [u8; 32],
    pub balance_ct: [u8; 32],
    pub chain: u16,
    pub bump: u8,
}
