use crate::constants::*;
use crate::error::HubError;
use crate::state::*;
use anchor_lang::prelude::*;
use ika_dwallet_anchor::DWalletContext;

#[event]
pub struct SettlementDispatched {
    pub intent_id: [u8; 32],
    pub dest_chain: u16,
    pub dest_domain: u32,
    pub ticker: [u8; 32],
    pub asset_hash: [u8; 32],
    pub amount: u64,
    pub recipient: [u8; 32],
    pub nonce: u64,
    /// 32-byte digest the Ika dWallet signs (relayer reproduces this off-chain).
    pub message_digest: [u8; 32],
    /// Signature scheme requested from Ika (1=secp256k1 ECDSA for EVM, 2=ed25519 for Solana).
    pub signature_scheme: u16,
}

/// Dispatch a revealed settlement: pack the canonical bytes, hash them, and
/// invoke `DWalletContext::approve_message` so the Ika dWallet authorizes
/// signing on the destination chain. The actual signature is produced by
/// the Ika 2PC-MPC network and stored on-chain; an off-chain relayer fetches
/// it and submits the destination-chain transaction.
///
/// `signature_scheme` lets the caller choose the curve: `1` for secp256k1
/// (EVM destinations) or `2` for ed25519 (Solana destination).
#[derive(Accounts)]
pub struct DispatchSettlement<'info> {
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

    // ── Ika CPI accounts (see ika-dwallet-anchor::DWalletContext) ──
    /// CHECK: Ika dWallet program.
    pub dwallet_program: UncheckedAccount<'info>,
    /// CHECK: Ika DWalletCoordinator PDA (provides epoch).
    pub coordinator: UncheckedAccount<'info>,
    /// CHECK: Pre-allocated MessageApproval PDA owned by the dWallet program.
    #[account(mut)]
    pub message_approval: UncheckedAccount<'info>,
    /// CHECK: The dWallet account whose authority is the hub's CPI authority PDA.
    pub dwallet: UncheckedAccount<'info>,
    /// CHECK: PDA derived from `[CPI_AUTHORITY_SEED]` of *this* program; signs the CPI.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: This hub program's id (executable account).
    pub caller_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<DispatchSettlement>,
    cpi_authority_bump: u8,
    message_approval_bump: u8,
    user_pubkey: [u8; 32],
    signature_scheme: u16,
    metadata_digest: [u8; 32],
) -> Result<()> {
    let rec = &mut ctx.accounts.settlement;
    require!(rec.revealed, HubError::NotRevealed);
    require!(!rec.dispatched, HubError::DuplicateIntent);

    // Build the canonical packed bytes the Ika network will produce a signature
    // over. The destination spoke recomputes this exact digest before
    // verifying the resulting signature.
    let packed = pack_settlement_order_bytes(rec);
    let message_digest = solana_program::hash::hash(&packed).to_bytes();

    let dctx = DWalletContext {
        dwallet_program: ctx.accounts.dwallet_program.to_account_info(),
        cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
        caller_program: ctx.accounts.caller_program.to_account_info(),
        cpi_authority_bump,
    };

    dctx.approve_message(
        &ctx.accounts.coordinator.to_account_info(),
        &ctx.accounts.message_approval.to_account_info(),
        &ctx.accounts.dwallet.to_account_info(),
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        message_digest,
        metadata_digest,
        user_pubkey,
        signature_scheme,
        message_approval_bump,
    )?;

    rec.dispatched = true;

    emit!(SettlementDispatched {
        intent_id: rec.intent_id,
        dest_chain: rec.dest_chain,
        dest_domain: rec.dest_domain,
        ticker: rec.ticker,
        asset_hash: rec.asset_hash,
        amount: rec.amount,
        recipient: rec.recipient,
        nonce: rec.nonce,
        message_digest,
        signature_scheme,
    });
    Ok(())
}

/// Wormhole chain id of Solana (the hub's chain).
const HUB_WH_CHAIN: u16 = 1;

/// Pack the SettlementOrder fields per the cross-chain wire format
/// (`packages/shared/messages.md`). Big-endian for all integers; bytes32
/// fields concatenated. Total: 153 bytes.
fn pack_settlement_order_bytes(rec: &SettlementRecord) -> Vec<u8> {
    let mut out = Vec::with_capacity(153);
    out.push(INTENT_VERSION);
    out.extend_from_slice(&HUB_WH_CHAIN.to_be_bytes());
    out.extend_from_slice(&rec.dest_chain.to_be_bytes());
    out.extend_from_slice(&rec.dest_domain.to_be_bytes());
    out.extend_from_slice(&rec.ticker);
    out.extend_from_slice(&rec.asset_hash);
    out.extend_from_slice(&rec.amount.to_be_bytes());
    out.extend_from_slice(&rec.recipient);
    out.extend_from_slice(&rec.intent_id);
    out.extend_from_slice(&rec.nonce.to_be_bytes());
    out
}
