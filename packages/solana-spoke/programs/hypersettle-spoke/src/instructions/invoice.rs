use crate::constants::*;
use crate::error::SpokeError;
use crate::state::*;
use anchor_lang::prelude::*;

#[event]
pub struct InvoicePosted {
    pub intent_id: [u8; 32],
    pub user: Pubkey,
    pub ticker: [u8; 32],
    pub amount_ct: [u8; 32],
    pub epoch: u64,
    pub recipient_chain: u16,
    pub recipient: [u8; 32],
    pub sequence: u64,
}

#[derive(Accounts)]
pub struct CreateInvoice<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, SpokeConfig>,
}

pub fn handler(
    ctx: Context<CreateInvoice>,
    ticker: [u8; 32],
    amount_ct: [u8; 32],
    epoch: u64,
    recipient_chain: u16,
    recipient: [u8; 32],
) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    let sequence = cfg.intent_sequence.checked_add(1).ok_or(SpokeError::AdminOnly)?;
    cfg.intent_sequence = sequence;

    let mut pre = Vec::with_capacity(32 + 8);
    pre.extend_from_slice(ctx.program_id.as_ref());
    pre.extend_from_slice(&sequence.to_le_bytes());
    let intent_id: [u8; 32] = solana_program::hash::hash(&pre).to_bytes();

    emit!(InvoicePosted {
        intent_id,
        user: ctx.accounts.user.key(),
        ticker,
        amount_ct,
        epoch,
        recipient_chain,
        recipient,
        sequence,
    });
    Ok(())
}
