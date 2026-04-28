use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct TickerBinding {
    pub ticker: [u8; 32],
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
}
