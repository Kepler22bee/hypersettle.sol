pub mod constants;
pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("6drKZi99yGyamt24HAYcsVh9KvqyqbjMNcPCkSzQiRQN");

#[program]
pub mod hypersettle_spoke {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        ika_dwallet: Pubkey,
        self_domain: u32,
        hub_chain: u16,
        self_chain: u16,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, ika_dwallet, self_domain, hub_chain, self_chain)
    }

    pub fn bind_ticker(ctx: Context<BindTicker>, ticker: [u8; 32]) -> Result<()> {
        instructions::bind_ticker::handler(ctx, ticker)
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        ticker: [u8; 32],
        asset_hash: [u8; 32],
        amount: u64,
        amount_ct: [u8; 32],
        epoch: u64,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, ticker, asset_hash, amount, amount_ct, epoch)
    }

    pub fn create_invoice(
        ctx: Context<CreateInvoice>,
        ticker: [u8; 32],
        amount_ct: [u8; 32],
        epoch: u64,
        recipient_chain: u16,
        recipient: [u8; 32],
    ) -> Result<()> {
        instructions::invoice::handler(ctx, ticker, amount_ct, epoch, recipient_chain, recipient)
    }

    pub fn execute_settlement(ctx: Context<ExecuteSettlement>, order: SettlementOrder) -> Result<()> {
        instructions::execute_settlement::handler(ctx, order)
    }
}
