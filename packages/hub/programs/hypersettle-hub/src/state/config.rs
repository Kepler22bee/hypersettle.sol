use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct HubConfig {
    pub admin: Pubkey,
    pub discount_rate_per_epoch: u32,
    pub max_discount_numerator: u32,
    pub discount_denominator: u64,
    pub max_deposits_per_bucket: u32,
    pub next_settlement_nonce: u64,
    pub bump: u8,
}
