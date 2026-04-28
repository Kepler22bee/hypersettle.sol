use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;

/// Consume a Wormhole-delivered deposit VAA payload.
///
/// `payload_bytes` is the raw VAA body (packed format per
/// `packages/shared/messages.md`). The caller (relayer / admin) also passes
/// the derived `ticker`, `epoch`, `domain` to match the bucket PDA seeds;
/// the handler verifies these agree with the payload and rejects any
/// mismatch. This avoids parsing `Vec<u8>` at seed-derivation time, which
/// Anchor's account-context macro does not support.
///
/// Phase 5: signer-posted (admin stands in for a Wormhole relayer).
/// Phase 6+: Wormhole CPI reads a `PostedMessage` account and passes the
/// verified payload to this handler.
#[derive(Accounts)]
#[instruction(
    emitter_chain: u16,
    emitter_address: [u8; 32],
    ticker: [u8; 32],
    epoch: u64,
    domain: u32,
)]
pub struct ReceiveDeposit<'info> {
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
        init_if_needed,
        payer = admin,
        seeds = [
            DEPOSIT_BUCKET_SEED,
            &ticker,
            &epoch.to_le_bytes(),
            &domain.to_le_bytes(),
        ],
        bump,
        space = 8 + DepositBucket::INIT_SPACE,
    )]
    pub bucket: Box<Account<'info, DepositBucket>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ReceiveDeposit>,
    emitter_chain: u16,
    emitter_address: [u8; 32],
    ticker: [u8; 32],
    epoch: u64,
    domain: u32,
    payload_bytes: Vec<u8>,
) -> Result<()> {
    let _ = emitter_address; // authenticated via RegisteredSpoke PDA seed

    let intent = parse_deposit_intent_packed(&payload_bytes)?;
    require!(intent.version == INTENT_VERSION, HubError::BadVersion);
    require!(intent.source_chain == emitter_chain, HubError::UnknownSpoke);
    require!(intent.source_domain == ctx.accounts.spoke.domain, HubError::UnknownSpoke);
    require!(intent.source_domain == domain, HubError::UnknownSpoke);
    require!(intent.ticker == ticker, HubError::BadVersion);
    require!(intent.epoch == epoch, HubError::BadVersion);

    let bucket = &mut ctx.accounts.bucket;
    if bucket.slot_count == 0 {
        bucket.ticker = intent.ticker;
        bucket.epoch = intent.epoch;
        bucket.source_domain = intent.source_domain;
        bucket.bump = ctx.bumps.bucket;
    }

    require!(
        (bucket.slot_count as usize) < MAX_DEPOSITS_PER_BUCKET,
        HubError::BucketFull
    );

    for slot in bucket.slots.iter() {
        require!(
            !(slot.occupied && slot.intent_id == intent.intent_id),
            HubError::DuplicateIntent
        );
    }

    let idx = bucket.slot_count as usize;
    bucket.slots[idx] = DepositSlot {
        intent_id: intent.intent_id,
        amount_ct: intent.amount_ct,
        source_chain: intent.source_chain,
        source_domain: intent.source_domain,
        epoch_deposited: intent.epoch,
        occupied: true,
    };
    bucket.slot_count += 1;

    Ok(())
}
