use anchor_lang::prelude::*;

/// Mirrors the hub's `DepositIntent` (`packages/hub/.../state/messages.rs`)
/// and the EVM spoke's Solidity struct. Borsh field order must match.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositIntent {
    pub version: u8,
    pub source_chain: u16,
    pub source_domain: u32,
    pub ticker: [u8; 32],
    pub asset_hash: [u8; 32],
    pub epoch: u64,
    pub amount_ct: [u8; 32],
    pub intent_id: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InvoiceIntent {
    pub version: u8,
    pub source_chain: u16,
    pub source_domain: u32,
    pub ticker: [u8; 32],
    pub epoch: u64,
    pub amount_ct: [u8; 32],
    pub recipient_chain: u16,
    pub recipient: [u8; 32],
    pub intent_id: [u8; 32],
}

/// The authoritative settlement payload. The Ika dWallet signs the SHA-256
/// digest of `borsh_serialize(order)` (ed25519 over the serialized bytes).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SettlementOrder {
    pub version: u8,
    pub source_chain: u16,
    pub dest_chain: u16,
    pub dest_domain: u32,
    pub ticker: [u8; 32],
    pub asset_hash: [u8; 32],
    pub amount: u64,
    pub recipient: [u8; 32],
    pub intent_id: [u8; 32],
    pub nonce: u64,
}

impl SettlementOrder {
    /// Canonical bytes the Ika dWallet signs.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        AnchorSerialize::serialize(self, &mut out).unwrap();
        out
    }
}
