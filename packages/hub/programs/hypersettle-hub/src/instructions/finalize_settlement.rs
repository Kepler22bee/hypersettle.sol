use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;
use encrypt_anchor::EncryptContext;
use encrypt_dsl::prelude::encrypt_fn;
#[allow(unused_imports)]
use encrypt_types::encrypted::EUint64;

/// Final settlement: net amount gated by available custody.
#[encrypt_fn]
pub fn settle_graph(
    invoice_amount: EUint64,
    total_rewards: EUint64,
    custody: EUint64,
) -> (EUint64, EUint64) {
    let raw_settled = invoice_amount - total_rewards;
    let enough = custody > raw_settled;
    let settled = if enough { raw_settled } else { custody };
    let new_custody = custody - settled;
    (settled, new_custody)
}

/// Compute the final encrypted settlement amount via `settle_graph`.
///
/// Inputs (encrypted): `invoice.amount_ct`, `rewards_ct` (caller-provided,
/// typically an accumulated rewards ciphertext or an encrypted-zero handle),
/// and `custody_ct` (from `CustodyLedger.balance_ct`).
///
/// Outputs (encrypted): `settled_ct` (fresh account) and updated custody
/// (in-place on `custody_ct`).
///
/// The hub produces `settled_ct` and records its pubkey plus a fresh
/// `SettlementRecord`. Reveal of the plaintext `amount` happens in
/// `request_settlement_decryption` + `reveal_settlement`.
#[derive(Accounts)]
#[instruction(asset_hash: [u8; 32])]
pub struct FinalizeSettlement<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ HubError::AdminOnly,
    )]
    pub config: Box<Account<'info, HubConfig>>,
    #[account(
        mut,
        seeds = [INVOICE_SEED, &invoice.intent_id],
        bump = invoice.bump,
    )]
    pub invoice: Box<Account<'info, Invoice>>,
    #[account(
        mut,
        seeds = [CUSTODY_SEED, &asset_hash, &invoice.recipient_chain.to_le_bytes()],
        bump = custody.bump,
    )]
    pub custody: Box<Account<'info, CustodyLedger>>,
    #[account(
        init,
        payer = admin,
        seeds = [SETTLEMENT_SEED, &invoice.intent_id],
        bump,
        space = 8 + SettlementRecord::INIT_SPACE,
    )]
    pub settlement: Box<Account<'info, SettlementRecord>>,

    /// CHECK: Encrypted invoice amount ct; pubkey must match `invoice.amount_ct`.
    pub invoice_amount_ct: UncheckedAccount<'info>,
    /// CHECK: Encrypted rewards total ct (client-accumulated across slot matches).
    pub rewards_ct: UncheckedAccount<'info>,
    /// CHECK: Encrypted custody balance ct; updated in-place.
    #[account(mut)]
    pub custody_ct: UncheckedAccount<'info>,
    /// CHECK: Fresh output ct for the settled amount.
    #[account(mut)]
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

pub fn handler(
    ctx: Context<FinalizeSettlement>,
    asset_hash: [u8; 32],
    cpi_authority_bump: u8,
) -> Result<()> {
    require!(!ctx.accounts.invoice.settled, HubError::AlreadyFinalized);

    require!(
        ctx.accounts.invoice_amount_ct.key().to_bytes() == ctx.accounts.invoice.amount_ct,
        HubError::DigestMismatch
    );
    require!(
        ctx.accounts.custody_ct.key().to_bytes() == ctx.accounts.custody.balance_ct,
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

    let invoice_amount = ctx.accounts.invoice_amount_ct.to_account_info();
    let rewards = ctx.accounts.rewards_ct.to_account_info();
    let custody_ct = ctx.accounts.custody_ct.to_account_info();
    let settled = ctx.accounts.settled_ct.to_account_info();

    // settle_graph(invoice, rewards, custody) -> (settled, new_custody)
    // In-place: `custody_ct` receives `new_custody`; `settled_ct` is fresh.
    encrypt_ctx.settle_graph(
        invoice_amount,
        rewards,
        custody_ct.clone(),
        settled,
        custody_ct,
    )?;

    // Record the settlement and bump the nonce.
    let cfg = &mut ctx.accounts.config;
    let invoice = &mut ctx.accounts.invoice;
    let rec = &mut ctx.accounts.settlement;

    rec.intent_id = invoice.intent_id;
    rec.dest_chain = invoice.recipient_chain;
    rec.dest_domain = invoice.source_domain;
    rec.ticker = invoice.ticker;
    rec.asset_hash = asset_hash;
    rec.recipient = invoice.recipient;
    rec.nonce = cfg.next_settlement_nonce;
    rec.settled_ct = ctx.accounts.settled_ct.key().to_bytes();
    rec.pending_digest = [0u8; 32];
    rec.amount = 0;
    rec.revealed = false;
    rec.dispatched = false;
    rec.bump = ctx.bumps.settlement;

    invoice.settled = true;
    cfg.next_settlement_nonce = cfg
        .next_settlement_nonce
        .checked_add(1)
        .ok_or(HubError::AmountOverflow)?;

    Ok(())
}
