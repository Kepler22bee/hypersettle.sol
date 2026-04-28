use crate::constants::MAX_DEPOSITS_PER_BUCKET;
use anchor_lang::prelude::*;

/// One deposit slot. `amount_ct` is the pubkey of an Encrypt ciphertext
/// account managed by the Encrypt program; the hub holds only the reference.
/// `epoch_deposited` stays plaintext — time is public per blueprint MM1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace, Default)]
pub struct DepositSlot {
    pub intent_id: [u8; 32],
    pub amount_ct: [u8; 32],
    pub source_chain: u16,
    pub source_domain: u32,
    pub epoch_deposited: u64,
    pub occupied: bool,
}

/// Fixed-size bucket of encrypted deposits for `(ticker, epoch, domain)`.
/// Fixed array size is required for the branchless per-slot matching loop.
#[account]
#[derive(InitSpace)]
pub struct DepositBucket {
    pub ticker: [u8; 32],
    pub epoch: u64,
    pub source_domain: u32,
    pub slot_count: u32,
    pub slots: [DepositSlot; MAX_DEPOSITS_PER_BUCKET],
    pub bump: u8,
}
