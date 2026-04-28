use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SpokeConfig {
    pub admin: Pubkey,
    /// Ed25519 pubkey of the Ika dWallet authorized to sign settlement orders.
    pub ika_dwallet: Pubkey,
    pub self_domain: u32,
    pub hub_chain: u16,
    pub self_chain: u16,
    pub intent_sequence: u64,
    pub bump: u8,
}
