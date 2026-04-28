use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Invoice {
    pub intent_id: [u8; 32],
    pub source_chain: u16,
    pub source_domain: u32,
    pub ticker: [u8; 32],
    pub epoch: u64,
    /// Pubkey of the original-invoice-amount ciphertext.
    pub amount_ct: [u8; 32],
    /// Pubkey of the running `remaining` ciphertext, mutated by `match_slot`.
    /// Initialized from `amount_ct` at invoice-receive time; drawn down each
    /// `match_slot_invoice` iteration.
    pub remaining_ct: [u8; 32],
    pub recipient_chain: u16,
    pub recipient: [u8; 32],
    pub slots_matched: u32,
    pub settled: bool,
    pub bump: u8,
}
