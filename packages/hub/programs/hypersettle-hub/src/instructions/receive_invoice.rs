use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(
    emitter_chain: u16,
    emitter_address: [u8; 32],
    intent_id: [u8; 32],
)]
pub struct ReceiveInvoice<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ HubError::AdminOnly,
    )]
    pub config: Account<'info, HubConfig>,
    #[account(
        seeds = [REGISTERED_SPOKE_SEED, &emitter_chain.to_le_bytes(), &emitter_address],
        bump = spoke.bump,
    )]
    pub spoke: Account<'info, RegisteredSpoke>,
    #[account(
        init,
        payer = admin,
        seeds = [INVOICE_SEED, &intent_id],
        bump,
        space = 8 + Invoice::INIT_SPACE,
    )]
    pub invoice: Account<'info, Invoice>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ReceiveInvoice>,
    emitter_chain: u16,
    emitter_address: [u8; 32],
    intent_id: [u8; 32],
    payload_bytes: Vec<u8>,
    remaining_ct: [u8; 32],
) -> Result<()> {
    let _ = emitter_address;

    let intent = parse_invoice_intent_packed(&payload_bytes)?;
    require!(intent.version == INTENT_VERSION, HubError::BadVersion);
    require!(intent.source_chain == emitter_chain, HubError::UnknownSpoke);
    require!(intent.source_domain == ctx.accounts.spoke.domain, HubError::UnknownSpoke);
    require!(intent.intent_id == intent_id, HubError::BadVersion);

    let inv = &mut ctx.accounts.invoice;
    inv.intent_id = intent.intent_id;
    inv.source_chain = intent.source_chain;
    inv.source_domain = intent.source_domain;
    inv.ticker = intent.ticker;
    inv.epoch = intent.epoch;
    inv.amount_ct = intent.amount_ct;
    inv.remaining_ct = remaining_ct;
    inv.recipient_chain = intent.recipient_chain;
    inv.recipient = intent.recipient;
    inv.slots_matched = 0;
    inv.settled = false;
    inv.bump = ctx.bumps.invoice;
    Ok(())
}
