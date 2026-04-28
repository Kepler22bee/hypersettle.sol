use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;
use encrypt_anchor::accounts::read_decrypted_verified;
use encrypt_types::encrypted::Uint64;

/// Verify the decryption request response against the stored digest and
/// populate the plaintext `amount` on the settlement record.
///
/// This is the *only* point in the protocol where an encrypted amount
/// transitions to plaintext. After this call, `dispatch_settlement` can
/// package the plaintext amount into a `SettlementOrder` and hand it to Ika
/// for signing on the destination chain.
#[derive(Accounts)]
pub struct RevealSettlement<'info> {
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
    /// CHECK: Completed decryption request account (Encrypt-owned).
    pub request_acct: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RevealSettlement>) -> Result<()> {
    require!(!ctx.accounts.settlement.revealed, HubError::AlreadyFinalized);

    let request_data = ctx.accounts.request_acct.try_borrow_data()?;
    let value = read_decrypted_verified::<Uint64>(
        &request_data,
        &ctx.accounts.settlement.pending_digest,
    )
    .map_err(|_| HubError::RevealFailed)?;

    let amount = *value;
    drop(request_data);

    let rec = &mut ctx.accounts.settlement;
    rec.amount = amount;
    rec.revealed = true;
    Ok(())
}
