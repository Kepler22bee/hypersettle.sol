use crate::constants::*;
use crate::error::SpokeError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

/// Admin-only: bind a ticker (e.g. `keccak256("USDC")`) to an SPL mint +
/// vault token account. The vault's authority is the spoke-authority PDA so
/// only the program can move funds out.
#[derive(Accounts)]
#[instruction(ticker: [u8; 32])]
pub struct BindTicker<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ SpokeError::AdminOnly,
    )]
    pub config: Account<'info, SpokeConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [TICKER_SEED, &ticker],
        bump,
        space = 8 + TickerBinding::INIT_SPACE,
    )]
    pub ticker_binding: Account<'info, TickerBinding>,
    /// CHECK: PDA seed-only; used as the vault's authority.
    #[account(
        seeds = [SPOKE_AUTHORITY_SEED],
        bump,
    )]
    pub spoke_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, &ticker],
        bump,
        token::mint = mint,
        token::authority = spoke_authority,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BindTicker>, ticker: [u8; 32]) -> Result<()> {
    let binding = &mut ctx.accounts.ticker_binding;
    binding.ticker = ticker;
    binding.mint = ctx.accounts.mint.key();
    binding.vault = ctx.accounts.vault.key();
    binding.bump = ctx.bumps.ticker_binding;
    Ok(())
}
