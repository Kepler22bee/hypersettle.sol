use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        seeds = [CONFIG_SEED],
        bump,
        space = 8 + HubConfig::INIT_SPACE,
    )]
    pub config: Account<'info, HubConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    discount_rate_per_epoch: u32,
    max_discount_numerator: u32,
) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.admin = ctx.accounts.admin.key();
    cfg.discount_rate_per_epoch = discount_rate_per_epoch;
    cfg.max_discount_numerator = max_discount_numerator;
    cfg.discount_denominator = DISCOUNT_DENOMINATOR;
    cfg.max_deposits_per_bucket = MAX_DEPOSITS_PER_BUCKET as u32;
    cfg.next_settlement_nonce = 0;
    cfg.bump = ctx.bumps.config;
    Ok(())
}
