use anchor_lang::prelude::*;

#[error_code]
pub enum SpokeError {
    #[msg("Admin signature required")]
    AdminOnly,
    #[msg("Zero pubkey not allowed")]
    ZeroPubkey,
    #[msg("Schema version not supported")]
    BadVersion,
    #[msg("Destination chain mismatch")]
    DestinationMismatch,
    #[msg("Destination domain mismatch")]
    DomainMismatch,
    #[msg("Nonce already consumed")]
    NonceAlreadyConsumed,
    #[msg("Invalid signature")]
    InvalidSignature,
    #[msg("Missing ed25519 precompile instruction")]
    MissingEd25519Ix,
    #[msg("Ed25519 precompile instruction does not match order digest/signer")]
    Ed25519IxMismatch,
    #[msg("Ticker not bound to a mint")]
    UnboundTicker,
    #[msg("Ticker/mint mismatch")]
    TickerMintMismatch,
}
