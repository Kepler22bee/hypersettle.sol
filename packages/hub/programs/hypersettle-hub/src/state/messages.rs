use crate::error::HubError;
use anchor_lang::prelude::*;

pub const INTENT_VERSION: u8 = 1;

/// `amount_ct` is the 32-byte pubkey of the Encrypt ciphertext account
/// allocated off-chain by the spoke's client. The hub stores the reference.
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

/// The only plaintext-amount message in the protocol.
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

// ── Cross-chain packed wire format ─────────────────────────────────────
//
// Canonical layout (matches `packages/shared/messages.md`). Big-endian for
// all integers so it matches Solidity's `abi.encodePacked` output without
// extra byte-swapping. Both the EVM spoke (`abi.encodePacked`) and the
// Solana hub (these parsers) agree on this format; Borsh is used only for
// internal Anchor state, not on the wire.
//
// DepositIntent packed:
//   u8 version | u16 source_chain | u32 source_domain | [32] ticker |
//   [32] asset_hash | u64 epoch | [32] amount_ct | [32] intent_id
//   = 1+2+4+32+32+8+32+32 = 143 bytes
//
// InvoiceIntent packed:
//   u8 version | u16 source_chain | u32 source_domain | [32] ticker |
//   u64 epoch | [32] amount_ct | u16 recipient_chain | [32] recipient |
//   [32] intent_id
//   = 1+2+4+32+8+32+2+32+32 = 145 bytes

pub const DEPOSIT_INTENT_PACKED_LEN: usize = 143;
pub const INVOICE_INTENT_PACKED_LEN: usize = 145;

#[inline(always)]
fn read_u8(bytes: &[u8], off: &mut usize) -> Result<u8> {
    let v = *bytes.get(*off).ok_or(HubError::BadVersion)?;
    *off += 1;
    Ok(v)
}

#[inline(always)]
fn read_u16_be(bytes: &[u8], off: &mut usize) -> Result<u16> {
    let slice = bytes.get(*off..*off + 2).ok_or(HubError::BadVersion)?;
    let v = u16::from_be_bytes([slice[0], slice[1]]);
    *off += 2;
    Ok(v)
}

#[inline(always)]
fn read_u32_be(bytes: &[u8], off: &mut usize) -> Result<u32> {
    let slice = bytes.get(*off..*off + 4).ok_or(HubError::BadVersion)?;
    let v = u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]);
    *off += 4;
    Ok(v)
}

#[inline(always)]
fn read_u64_be(bytes: &[u8], off: &mut usize) -> Result<u64> {
    let slice = bytes.get(*off..*off + 8).ok_or(HubError::BadVersion)?;
    let mut out = [0u8; 8];
    out.copy_from_slice(slice);
    *off += 8;
    Ok(u64::from_be_bytes(out))
}

#[inline(always)]
fn read_bytes32(bytes: &[u8], off: &mut usize) -> Result<[u8; 32]> {
    let slice = bytes.get(*off..*off + 32).ok_or(HubError::BadVersion)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(slice);
    *off += 32;
    Ok(out)
}

pub fn parse_deposit_intent_packed(payload: &[u8]) -> Result<DepositIntent> {
    require!(payload.len() == DEPOSIT_INTENT_PACKED_LEN, HubError::BadVersion);
    let mut o = 0usize;
    let version = read_u8(payload, &mut o)?;
    let source_chain = read_u16_be(payload, &mut o)?;
    let source_domain = read_u32_be(payload, &mut o)?;
    let ticker = read_bytes32(payload, &mut o)?;
    let asset_hash = read_bytes32(payload, &mut o)?;
    let epoch = read_u64_be(payload, &mut o)?;
    let amount_ct = read_bytes32(payload, &mut o)?;
    let intent_id = read_bytes32(payload, &mut o)?;
    Ok(DepositIntent {
        version,
        source_chain,
        source_domain,
        ticker,
        asset_hash,
        epoch,
        amount_ct,
        intent_id,
    })
}

pub fn parse_invoice_intent_packed(payload: &[u8]) -> Result<InvoiceIntent> {
    require!(payload.len() == INVOICE_INTENT_PACKED_LEN, HubError::BadVersion);
    let mut o = 0usize;
    let version = read_u8(payload, &mut o)?;
    let source_chain = read_u16_be(payload, &mut o)?;
    let source_domain = read_u32_be(payload, &mut o)?;
    let ticker = read_bytes32(payload, &mut o)?;
    let epoch = read_u64_be(payload, &mut o)?;
    let amount_ct = read_bytes32(payload, &mut o)?;
    let recipient_chain = read_u16_be(payload, &mut o)?;
    let recipient = read_bytes32(payload, &mut o)?;
    let intent_id = read_bytes32(payload, &mut o)?;
    Ok(InvoiceIntent {
        version,
        source_chain,
        source_domain,
        ticker,
        epoch,
        amount_ct,
        recipient_chain,
        recipient,
        intent_id,
    })
}
