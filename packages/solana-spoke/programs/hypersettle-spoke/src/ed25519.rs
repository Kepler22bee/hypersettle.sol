//! Ed25519 signature verification via the native precompile.
//!
//! Solana programs cannot verify ed25519 directly. The standard pattern is:
//!   1. Caller prepends an `Ed25519Program` precompile instruction to the tx
//!      that has the runtime verify `(pubkey, signature, message)`.
//!   2. Our instruction reads the previous instruction from the Instructions
//!      sysvar and enforces that its declared pubkey + message match the
//!      settlement authorization we expect.
//!
//! We read the precompile's offsets dynamically (`@solana/web3.js`
//! `createInstructionWithPublicKey` uses a different layout than
//! `createInstructionWithPrivateKey`), then slice the pubkey / message out
//! of the instruction data for comparison.

use crate::error::SpokeError;
use anchor_lang::prelude::*;
use solana_program::ed25519_program::ID as ED25519_PROGRAM_ID;
use solana_program::sysvar::instructions::{load_instruction_at_checked, ID as IX_SYSVAR_ID};

const HEADER_LEN: usize = 2; // num_sigs + padding
const OFFSETS_LEN: usize = 14; // one signature entry
const SIG_LEN: usize = 64;
const PUB_LEN: usize = 32;

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    let slice = data.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

pub fn verify_prior_ed25519_ix(
    ix_sysvar: &AccountInfo,
    current_ix_index: u16,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8],
) -> Result<()> {
    require!(
        ix_sysvar.key() == IX_SYSVAR_ID,
        SpokeError::MissingEd25519Ix
    );
    require!(current_ix_index > 0, SpokeError::MissingEd25519Ix);

    let prior = load_instruction_at_checked((current_ix_index - 1) as usize, ix_sysvar)
        .map_err(|_| SpokeError::MissingEd25519Ix)?;

    require!(
        prior.program_id == ED25519_PROGRAM_ID,
        SpokeError::MissingEd25519Ix
    );

    let data = &prior.data;
    require!(data.len() >= HEADER_LEN + OFFSETS_LEN, SpokeError::Ed25519IxMismatch);
    require!(data[0] == 1, SpokeError::Ed25519IxMismatch);

    let sig_offset = read_u16_le(data, 2).ok_or(SpokeError::Ed25519IxMismatch)? as usize;
    let sig_ix_idx = read_u16_le(data, 4).ok_or(SpokeError::Ed25519IxMismatch)?;
    let pub_offset = read_u16_le(data, 6).ok_or(SpokeError::Ed25519IxMismatch)? as usize;
    let pub_ix_idx = read_u16_le(data, 8).ok_or(SpokeError::Ed25519IxMismatch)?;
    let msg_offset = read_u16_le(data, 10).ok_or(SpokeError::Ed25519IxMismatch)? as usize;
    let msg_size = read_u16_le(data, 12).ok_or(SpokeError::Ed25519IxMismatch)? as usize;
    let msg_ix_idx = read_u16_le(data, 14).ok_or(SpokeError::Ed25519IxMismatch)?;

    // All three references must point inside this same instruction
    // (ix_idx == 0xFFFF means "this instruction's data").
    require!(
        sig_ix_idx == 0xFFFF && pub_ix_idx == 0xFFFF && msg_ix_idx == 0xFFFF,
        SpokeError::Ed25519IxMismatch
    );

    // Silence unused (kept for completeness/audit).
    let _ = sig_offset;
    let _ = SIG_LEN;

    let pub_end = pub_offset + PUB_LEN;
    let msg_end = msg_offset + msg_size;
    require!(data.len() >= pub_end && data.len() >= msg_end, SpokeError::Ed25519IxMismatch);

    require!(
        &data[pub_offset..pub_end] == expected_pubkey.as_slice(),
        SpokeError::Ed25519IxMismatch
    );
    require!(
        msg_size == expected_message.len()
            && &data[msg_offset..msg_end] == expected_message,
        SpokeError::Ed25519IxMismatch
    );

    Ok(())
}
