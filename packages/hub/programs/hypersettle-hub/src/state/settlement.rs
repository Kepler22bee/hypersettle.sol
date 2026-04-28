use anchor_lang::prelude::*;

/// Record of a matched invoice, progressing through:
///   `finalize_settlement`          → `settled_ct` populated
///   `request_settlement_decryption` → `pending_digest` populated
///   `reveal_settlement`            → `amount` populated, `revealed = true`
///   `dispatch_settlement`          → `dispatched = true` (requires revealed)
#[account]
#[derive(InitSpace)]
pub struct SettlementRecord {
    pub intent_id: [u8; 32],
    pub dest_chain: u16,
    pub dest_domain: u32,
    pub ticker: [u8; 32],
    pub asset_hash: [u8; 32],
    pub recipient: [u8; 32],
    pub nonce: u64,
    /// Ciphertext account holding the encrypted settled amount.
    pub settled_ct: [u8; 32],
    /// Digest snapshot captured at `request_decryption` time, verified at reveal.
    pub pending_digest: [u8; 32],
    /// Plaintext settlement amount. Zero until `reveal_settlement`.
    pub amount: u64,
    pub revealed: bool,
    pub dispatched: bool,
    pub bump: u8,
}
