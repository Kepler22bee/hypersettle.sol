use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;

/// Admin-only: whitelist a spoke emitter for inbound VAA consumption.
/// Keyed by `(chain, emitter_address)` so each chain can have multiple
/// spokes (mainnet USDC pool vs. custody pool, etc.).
#[derive(Accounts)]
#[instruction(chain: u16, emitter: [u8; 32], domain: u32)]
pub struct RegisterSpoke<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ HubError::AdminOnly,
    )]
    pub config: Account<'info, HubConfig>,
    #[account(
        init,
        payer = admin,
        seeds = [REGISTERED_SPOKE_SEED, &chain.to_le_bytes(), &emitter],
        bump,
        space = 8 + RegisteredSpoke::INIT_SPACE,
    )]
    pub spoke: Account<'info, RegisteredSpoke>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterSpoke>,
    chain: u16,
    emitter: [u8; 32],
    domain: u32,
) -> Result<()> {
    let s = &mut ctx.accounts.spoke;
    s.chain = chain;
    s.emitter = emitter;
    s.domain = domain;
    s.bump = ctx.bumps.spoke;
    Ok(())
}
