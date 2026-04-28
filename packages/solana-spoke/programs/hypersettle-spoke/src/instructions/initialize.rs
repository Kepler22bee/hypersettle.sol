use crate::constants::*;
use crate::error::SpokeError;
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
        space = 8 + SpokeConfig::INIT_SPACE,
    )]
    pub config: Account<'info, SpokeConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    ika_dwallet: Pubkey,
    self_domain: u32,
    hub_chain: u16,
    self_chain: u16,
) -> Result<()> {
    require!(ika_dwallet != Pubkey::default(), SpokeError::ZeroPubkey);

    let cfg = &mut ctx.accounts.config;
    cfg.admin = ctx.accounts.admin.key();
    cfg.ika_dwallet = ika_dwallet;
    cfg.self_domain = self_domain;
    cfg.hub_chain = hub_chain;
    cfg.self_chain = self_chain;
    cfg.intent_sequence = 0;
    cfg.bump = ctx.bumps.config;
    Ok(())
}
