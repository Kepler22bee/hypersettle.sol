use crate::constants::*;
use crate::error::SpokeError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

#[event]
pub struct DepositPosted {
    pub intent_id: [u8; 32],
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub amount_ct: [u8; 32],
    pub sequence: u64,
    pub ticker: [u8; 32],
    pub asset_hash: [u8; 32],
    pub epoch: u64,
}

/// Custody `amount` of the ticker's SPL token into the vault and emit a
/// `DepositIntent` event. Phase 5 replaces the event with a real Wormhole
/// CPI (`wormhole::post_message`).
#[derive(Accounts)]
#[instruction(ticker: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, SpokeConfig>,
    #[account(
        seeds = [TICKER_SEED, &ticker],
        bump = ticker_binding.bump,
    )]
    pub ticker_binding: Account<'info, TickerBinding>,
    #[account(
        address = ticker_binding.mint @ SpokeError::TickerMintMismatch,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        address = ticker_binding.vault @ SpokeError::TickerMintMismatch,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(
    ctx: Context<Deposit>,
    ticker: [u8; 32],
    asset_hash: [u8; 32],
    amount: u64,
    amount_ct: [u8; 32],
    epoch: u64,
) -> Result<()> {
    let cfg = &mut ctx.accounts.config;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let sequence = cfg.intent_sequence.checked_add(1).ok_or(SpokeError::AdminOnly)?;
    cfg.intent_sequence = sequence;

    let mut pre = Vec::with_capacity(32 + 8);
    pre.extend_from_slice(ctx.program_id.as_ref());
    pre.extend_from_slice(&sequence.to_le_bytes());
    // sha256 instead of keccak — Anchor v1 doesn't re-export keccak; the
    // intent_id is an opaque unique handle so the choice of hash is internal.
    let intent_id: [u8; 32] = solana_program::hash::hash(&pre).to_bytes();

    emit!(DepositPosted {
        intent_id,
        user: ctx.accounts.user.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        amount_ct,
        sequence,
        ticker,
        asset_hash,
        epoch,
    });
    Ok(())
}
