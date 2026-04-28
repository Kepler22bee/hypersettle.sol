use anchor_lang::prelude::*;

#[error_code]
pub enum HubError {
    #[msg("Admin signature required")]
    AdminOnly,
    #[msg("Deposit bucket is full")]
    BucketFull,
    #[msg("Intent id already consumed")]
    DuplicateIntent,
    #[msg("Unknown source spoke")]
    UnknownSpoke,
    #[msg("Amount overflow")]
    AmountOverflow,
    #[msg("Schema version not supported")]
    BadVersion,
    #[msg("Slot index out of range")]
    SlotOutOfRange,
    #[msg("Slot already matched")]
    SlotAlreadyMatched,
    #[msg("Settlement already finalized")]
    AlreadyFinalized,
    #[msg("Settlement not finalized yet")]
    NotFinalized,
    #[msg("Decryption has not been revealed yet")]
    NotRevealed,
    #[msg("Digest mismatch on reveal")]
    DigestMismatch,
    #[msg("Decryption reveal failed")]
    RevealFailed,
}
