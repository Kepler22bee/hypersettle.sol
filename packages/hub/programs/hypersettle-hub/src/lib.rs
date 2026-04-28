pub mod constants;
pub mod error;
pub mod fhe;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("57UTU1LKC3KUiFqP52KTB4StqTxzmq27XJdpunKhWo5i");

#[program]
pub mod hypersettle_hub {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        discount_rate_per_epoch: u32,
        max_discount_numerator: u32,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, discount_rate_per_epoch, max_discount_numerator)
    }

    pub fn register_spoke(
        ctx: Context<RegisterSpoke>,
        chain: u16,
        emitter: [u8; 32],
        domain: u32,
    ) -> Result<()> {
        instructions::register_spoke::handler(ctx, chain, emitter, domain)
    }

    pub fn receive_deposit(
        ctx: Context<ReceiveDeposit>,
        emitter_chain: u16,
        emitter_address: [u8; 32],
        ticker: [u8; 32],
        epoch: u64,
        domain: u32,
        payload_bytes: Vec<u8>,
    ) -> Result<()> {
        instructions::receive_deposit::handler(
            ctx, emitter_chain, emitter_address, ticker, epoch, domain, payload_bytes,
        )
    }

    pub fn receive_invoice(
        ctx: Context<ReceiveInvoice>,
        emitter_chain: u16,
        emitter_address: [u8; 32],
        intent_id: [u8; 32],
        payload_bytes: Vec<u8>,
        remaining_ct: [u8; 32],
    ) -> Result<()> {
        instructions::receive_invoice::handler(
            ctx,
            emitter_chain,
            emitter_address,
            intent_id,
            payload_bytes,
            remaining_ct,
        )
    }

    pub fn match_slot_invoice(
        ctx: Context<MatchSlotInvoice>,
        slot_index: u32,
        cpi_authority_bump: u8,
    ) -> Result<()> {
        instructions::match_slot_invoice::handler(ctx, slot_index, cpi_authority_bump)
    }

    pub fn finalize_settlement(
        ctx: Context<FinalizeSettlement>,
        asset_hash: [u8; 32],
        cpi_authority_bump: u8,
    ) -> Result<()> {
        instructions::finalize_settlement::handler(ctx, asset_hash, cpi_authority_bump)
    }

    pub fn request_settlement_decryption(
        ctx: Context<RequestSettlementDecryption>,
        cpi_authority_bump: u8,
    ) -> Result<()> {
        instructions::request_settlement_decryption::handler(ctx, cpi_authority_bump)
    }

    pub fn reveal_settlement(ctx: Context<RevealSettlement>) -> Result<()> {
        instructions::reveal_settlement::handler(ctx)
    }

    pub fn dispatch_settlement(
        ctx: Context<DispatchSettlement>,
        cpi_authority_bump: u8,
        message_approval_bump: u8,
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        metadata_digest: [u8; 32],
    ) -> Result<()> {
        instructions::dispatch_settlement::handler(
            ctx,
            cpi_authority_bump,
            message_approval_bump,
            user_pubkey,
            signature_scheme,
            metadata_digest,
        )
    }
}
