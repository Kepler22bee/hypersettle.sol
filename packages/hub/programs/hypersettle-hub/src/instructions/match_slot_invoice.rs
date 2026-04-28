use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;
use encrypt_anchor::EncryptContext;
use encrypt_dsl::prelude::encrypt_fn;
#[allow(unused_imports)]
use encrypt_types::encrypted::EUint64;

/// Match one deposit slot against remaining invoice demand.
///
/// Outputs: `new_remaining`, `new_deposit`, `coverage`.
/// `min(r, d)` handles the empty-slot / full-invoice edges without a branch.
///
/// Defined here (rather than in `crate::fhe`) because the `#[encrypt_fn]`
/// macro emits a private CPI-trait alongside the graph fn, and that trait
/// must be in scope at the call site. The pure-graph version in `fhe.rs`
/// is used by the `run_mock` unit tests; it defines the same logic.
#[encrypt_fn]
pub fn match_slot_graph(remaining: EUint64, deposit: EUint64) -> (EUint64, EUint64, EUint64) {
    let coverage = if remaining < deposit { remaining } else { deposit };
    let new_remaining = remaining - coverage;
    let new_deposit = deposit - coverage;
    (new_remaining, new_deposit, coverage)
}

/// Match one deposit slot against an invoice's remaining demand.
///
/// The caller provides the two in-place ciphertext accounts (`remaining_ct`,
/// `deposit_ct`) and one fresh ciphertext account for `coverage_ct`. All
/// three pubkeys are verified against the hub's stored references.
///
/// One CPI per call, one graph evaluation off-chain. Callers iterate slot
/// indices 0..slot_count sequentially. Account count in the Accounts struct
/// is kept tight (~15 accounts) so 16 iterations do not exceed the
/// per-transaction account limit when batched.
#[derive(Accounts)]
pub struct MatchSlotInvoice<'info> {
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
        seeds = [INVOICE_SEED, &invoice.intent_id],
        bump = invoice.bump,
    )]
    pub invoice: Box<Account<'info, Invoice>>,
    #[account(mut)]
    pub bucket: Box<Account<'info, DepositBucket>>,

    /// CHECK: Encrypt ciphertext; pubkey verified against `invoice.remaining_ct`.
    #[account(mut)]
    pub remaining_ct: UncheckedAccount<'info>,
    /// CHECK: Encrypt ciphertext; pubkey verified against `bucket.slots[idx].amount_ct`.
    #[account(mut)]
    pub deposit_ct: UncheckedAccount<'info>,
    /// CHECK: Fresh ciphertext account allocated client-side for this slot's coverage.
    #[account(mut)]
    pub coverage_ct: UncheckedAccount<'info>,

    // ── Encrypt CPI accounts (see encrypt-anchor::EncryptContext) ──
    /// CHECK: Encrypt program.
    pub encrypt_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt config.
    pub encrypt_config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit (fee).
    #[account(mut)]
    pub encrypt_deposit: UncheckedAccount<'info>,
    /// CHECK: CPI authority PDA derived from [CPI_AUTHORITY_SEED].
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: Caller program (this hub's program id).
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt network encryption key.
    pub network_encryption_key: UncheckedAccount<'info>,
    /// CHECK: Encrypt event authority.
    pub event_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<MatchSlotInvoice>,
    slot_index: u32,
    cpi_authority_bump: u8,
) -> Result<()> {
    let idx = slot_index as usize;
    require!(idx < MAX_DEPOSITS_PER_BUCKET, HubError::SlotOutOfRange);

    let slot = ctx.accounts.bucket.slots[idx];
    require!(slot.occupied, HubError::SlotOutOfRange);

    require!(
        ctx.accounts.remaining_ct.key().to_bytes() == ctx.accounts.invoice.remaining_ct,
        HubError::DigestMismatch
    );
    require!(
        ctx.accounts.deposit_ct.key().to_bytes() == slot.amount_ct,
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

    let remaining = ctx.accounts.remaining_ct.to_account_info();
    let deposit = ctx.accounts.deposit_ct.to_account_info();
    let coverage = ctx.accounts.coverage_ct.to_account_info();

    // Signature: (input_remaining, input_deposit, output_new_remaining, output_new_deposit, output_coverage).
    // In-place update: same account used for input and output of remaining/deposit.
    encrypt_ctx.match_slot_graph(
        remaining.clone(),
        deposit.clone(),
        remaining,
        deposit,
        coverage,
    )?;

    ctx.accounts.invoice.slots_matched = ctx
        .accounts
        .invoice
        .slots_matched
        .checked_add(1)
        .ok_or(HubError::AmountOverflow)?;

    Ok(())
}
