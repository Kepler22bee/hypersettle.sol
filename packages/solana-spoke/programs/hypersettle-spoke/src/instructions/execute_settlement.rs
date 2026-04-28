use crate::constants::*;
use crate::ed25519::verify_prior_ed25519_ix;
use crate::error::SpokeError;
use crate::state::*;
use anchor_lang::prelude::*;
use solana_program::sysvar::instructions::{load_current_index_checked, ID as IX_SYSVAR_ID};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

#[event]
pub struct SettlementExecuted {
    pub intent_id: [u8; 32],
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

/// Verify an Ika-signed `SettlementOrder` and transfer `order.amount` of the
/// ticker's SPL token from the vault to `recipient_token_account`.
///
/// Auth:
///   - `order.version` must be current.
///   - `order.dest_chain` must match `config.self_chain`.
///   - `order.dest_domain` must match `config.self_domain`.
///   - The preceding instruction in the transaction must be an ed25519
///     precompile verification attesting `signature_of(config.ika_dwallet,
///     borsh(order))`.
///   - The `consumed_nonce` PDA must not already exist (created here ⇒
///     future replay attempts fail on `init`).
#[derive(Accounts)]
#[instruction(order: SettlementOrder)]
pub struct ExecuteSettlement<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, SpokeConfig>,
    #[account(
        seeds = [TICKER_SEED, &ticker_binding.ticker],
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
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA seed-only; signs the vault-out transfer.
    #[account(
        seeds = [SPOKE_AUTHORITY_SEED],
        bump,
    )]
    pub spoke_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [NONCE_SEED, &order.nonce.to_le_bytes()],
        bump,
        space = 8 + ConsumedNonce::INIT_SPACE,
    )]
    pub consumed_nonce: Account<'info, ConsumedNonce>,
    /// CHECK: `solana-program::sysvar::instructions::ID` — used to read the
    /// ed25519 precompile instruction.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteSettlement>, order: SettlementOrder) -> Result<()> {
    require!(
        order.version == INTENT_VERSION,
        SpokeError::BadVersion
    );
    require!(
        order.dest_chain == ctx.accounts.config.self_chain,
        SpokeError::DestinationMismatch
    );
    require!(
        order.dest_domain == ctx.accounts.config.self_domain,
        SpokeError::DomainMismatch
    );
    require!(
        order.ticker == ctx.accounts.ticker_binding.ticker,
        SpokeError::TickerMintMismatch
    );

    // Verify the ed25519 precompile instruction preceding us in this tx.
    let current_ix = load_current_index_checked(&ctx.accounts.instructions_sysvar.to_account_info())
        .map_err(|_| SpokeError::MissingEd25519Ix)?;
    let dwallet_bytes = ctx.accounts.config.ika_dwallet.to_bytes();
    let message = order.signing_bytes();
    verify_prior_ed25519_ix(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        current_ix,
        &dwallet_bytes,
        &message,
    )?;

    // Record the nonce (account is freshly init'd; re-exec would fail init).
    let nonce_acct = &mut ctx.accounts.consumed_nonce;
    nonce_acct.nonce = order.nonce;
    nonce_acct.bump = ctx.bumps.consumed_nonce;

    // Transfer vault → recipient, signed by spoke_authority PDA.
    let authority_bump = ctx.bumps.spoke_authority;
    let seeds: &[&[u8]] = &[SPOKE_AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            token_interface::TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.spoke_authority.to_account_info(),
            },
            signer_seeds,
        ),
        order.amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(SettlementExecuted {
        intent_id: order.intent_id,
        recipient: ctx.accounts.recipient_token_account.key(),
        mint: ctx.accounts.mint.key(),
        amount: order.amount,
        nonce: order.nonce,
    });
    Ok(())
}
