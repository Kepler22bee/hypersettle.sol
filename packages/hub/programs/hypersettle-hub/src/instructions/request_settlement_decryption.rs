use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;
use encrypt_anchor::EncryptContext;

/// Request decryption of `settlement.settled_ct`. The Encrypt program stores
/// the ciphertext digest on the request account; we snapshot that digest
/// here for later reveal-time verification.
#[derive(Accounts)]
pub struct RequestSettlementDecryption<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ HubError::AdminOnly,
    )]
    pub config: Account<'info, HubConfig>,
    #[account(
        mut,
        seeds = [SETTLEMENT_SEED, &settlement.intent_id],
        bump = settlement.bump,
    )]
    pub settlement: Box<Account<'info, SettlementRecord>>,

    /// CHECK: Decryption request account, created by the Encrypt program.
    #[account(mut)]
    pub request_acct: UncheckedAccount<'info>,
    /// CHECK: Settlement ciphertext; pubkey must match `settlement.settled_ct`.
    pub settled_ct: UncheckedAccount<'info>,

    /// CHECK: Encrypt program.
    pub encrypt_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt config.
    pub encrypt_config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit.
    #[account(mut)]
    pub encrypt_deposit: UncheckedAccount<'info>,
    /// CHECK: CPI authority PDA.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: Caller program.
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt network encryption key.
    pub network_encryption_key: UncheckedAccount<'info>,
    /// CHECK: Encrypt event authority.
    pub event_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RequestSettlementDecryption>, cpi_authority_bump: u8) -> Result<()> {
    require!(!ctx.accounts.settlement.revealed, HubError::NotFinalized);
    require!(
        ctx.accounts.settled_ct.key().to_bytes() == ctx.accounts.settlement.settled_ct,
        HubError::DigestMismatch
    );

    let encrypt_ctx = EncryptContext {
        encrypt_program: ctx.accounts.encrypt_program.to_account_info(),
        config: ctx.accounts.encrypt_config.to_account_info(),
        deposit: ctx.accounts.encrypt_deposit.to_account_info(),
        cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
        caller_program: ctx.accounts.caller_program.to_account_info(),
        network_encryption_key: ctx.accounts.network_encryption_key.to_account_info(),
        payer: ctx.accounts.admin.to_account_info(),
        event_authority: ctx.accounts.event_authority.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        cpi_authority_bump,
    };

    let digest = encrypt_ctx.request_decryption(
        &ctx.accounts.request_acct.to_account_info(),
        &ctx.accounts.settled_ct.to_account_info(),
    )?;

    ctx.accounts.settlement.pending_digest = digest;
    Ok(())
}
