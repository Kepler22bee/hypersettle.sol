use anchor_lang::prelude::*;

/// Existence of a PDA at `[NONCE_SEED, nonce.to_le_bytes()]` marks the nonce
/// as consumed. The account itself stores only a bump and the nonce value
/// for clarity; replay protection is purely by address-existence check at
/// init time (`init` fails if the account already exists).
#[account]
#[derive(InitSpace)]
pub struct ConsumedNonce {
    pub nonce: u64,
    pub bump: u8,
}
