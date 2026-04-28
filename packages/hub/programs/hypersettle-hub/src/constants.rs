pub const CONFIG_SEED: &[u8] = b"config";
pub const DEPOSIT_BUCKET_SEED: &[u8] = b"deposits";
pub const INVOICE_SEED: &[u8] = b"invoice";
pub const CUSTODY_SEED: &[u8] = b"custody";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const REGISTERED_SPOKE_SEED: &[u8] = b"spoke";

// Fixed bucket size for the branchless matching loop. Kept conservative to
// stay under BPF stack limits with the 32-byte ciphertext-pubkey slot layout.
// Bumping this requires migrating DepositBucket to #[account(zero_copy)].
pub const MAX_DEPOSITS_PER_BUCKET: usize = 8;
pub const DISCOUNT_DENOMINATOR: u64 = 1_000_000;
pub const MAX_DISCOUNT_NUMERATOR: u64 = 500_000;
