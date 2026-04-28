//! FHE netting graphs for HyperSettle, expressed in the Encrypt DSL.
//!
//! Each `#[encrypt_fn]` compiles to a DAG of FHE operations that the Encrypt
//! executor evaluates off-chain. Within the body, every conditional is
//! branchless: `if cond { a } else { b }` lowers to a `select(cond, a, b)`
//! op over encrypted operands, so both arms are evaluated unconditionally.
//! This matches the blueprint's Mental Model 2.
//!
//! Clients encrypt amounts off-chain via the Encrypt gRPC `create_input` API,
//! producing ciphertext account pubkeys that travel in Wormhole payloads. The
//! hub's `match_invoice` instruction (Phase 2b) invokes
//! `EncryptContext::match_slot_graph` / `settle_graph` per iteration; the
//! graphs defined here are the authoritative logic.
//!
//! Phase 2 validates the graphs via `run_mock` unit tests at the bottom of
//! this file, re-running reference vectors from Phase 1's plaintext
//! `netting.rs` and asserting identical outputs.

use encrypt_dsl::prelude::encrypt_fn;
#[allow(unused_imports)]
use encrypt_types::encrypted::EUint64;

/// Match one deposit slot against remaining invoice demand.
///
/// Outputs, in order: `new_remaining`, `new_deposit`, `coverage`.
///
/// We rely on `min(r, d)` to handle the empty-slot / full-invoice edges:
/// when either operand is zero, `min` is zero, so coverage is zero and the
/// subtractions are no-ops. This avoids a bare encrypted-zero literal in a
/// branch (the Encrypt DSL only allows encrypted values as branch results).
#[encrypt_fn]
pub fn match_slot_graph(remaining: EUint64, deposit: EUint64) -> (EUint64, EUint64, EUint64) {
    let coverage = if remaining < deposit { remaining } else { deposit };
    let new_remaining = remaining - coverage;
    let new_deposit = deposit - coverage;
    (new_remaining, new_deposit, coverage)
}

/// Compute one slot's reward contribution.
///
/// `disc_over_denom` is the client-precomputed fraction
/// `min(age * rate, max_discount) / denominator`, encrypted off-chain.
#[encrypt_fn]
pub fn apply_reward_graph(coverage: EUint64, disc_over_denom: EUint64) -> EUint64 {
    coverage * disc_over_denom
}

/// Final settlement: compute net settle amount and post-settlement custody,
/// gated by available custody.
///
/// If `custody >= invoice - rewards`, settle the full net amount.
/// Otherwise, mask the settlement to the available custody (no revert).
/// Reverting on an encrypted condition would leak — MM2.
#[encrypt_fn]
pub fn settle_graph(
    invoice_amount: EUint64,
    total_rewards: EUint64,
    custody: EUint64,
) -> (EUint64, EUint64) {
    let raw_settled = invoice_amount - total_rewards;
    let enough = custody > raw_settled;
    let settled = if enough { raw_settled } else { custody };
    let new_custody = custody - settled;
    (settled, new_custody)
}

#[cfg(test)]
mod tests {
    use encrypt_types::graph::{get_node, parse_graph, GraphNodeKind};
    use encrypt_types::identifier::*;
    use encrypt_types::types::FheType;

    use super::{apply_reward_graph, match_slot_graph, settle_graph};

    /// Evaluate a compiled `#[encrypt_fn]` graph with plaintext inputs using
    /// the Encrypt mock primitives. Mirrors the pattern from the upstream
    /// counter-anchor example.
    fn run_mock(
        graph_fn: fn() -> Vec<u8>,
        inputs: &[u128],
        fhe_types: &[FheType],
    ) -> Vec<u128> {
        let data = graph_fn();
        let pg = parse_graph(&data).unwrap();
        let num = pg.header().num_nodes() as usize;
        let mut digests: Vec<[u8; 32]> = Vec::with_capacity(num);
        let mut inp = 0usize;

        for i in 0..num {
            let n = get_node(pg.node_bytes(), i as u16).unwrap();
            let ft = FheType::from_u8(n.fhe_type()).unwrap_or(FheType::EUint64);
            let d = match n.kind() {
                k if k == GraphNodeKind::Input as u8 => {
                    let v = inputs[inp];
                    let t = fhe_types[inp];
                    inp += 1;
                    encode_mock_digest(t, v)
                }
                k if k == GraphNodeKind::Constant as u8 => {
                    let bw = ft.byte_width().min(16);
                    let off = n.const_offset() as usize;
                    let mut buf = [0u8; 16];
                    buf[..bw].copy_from_slice(&pg.constants()[off..off + bw]);
                    encode_mock_digest(ft, u128::from_le_bytes(buf))
                }
                k if k == GraphNodeKind::Op as u8 => {
                    let (a, b, c) = (
                        n.input_a() as usize,
                        n.input_b() as usize,
                        n.input_c() as usize,
                    );
                    if n.op_type() == 60 {
                        mock_select(&digests[a], &digests[b], &digests[c])
                    } else if b == 0xFFFF {
                        mock_unary_compute(
                            unsafe {
                                core::mem::transmute::<u8, encrypt_types::types::FheOperation>(
                                    n.op_type(),
                                )
                            },
                            &digests[a],
                            ft,
                        )
                    } else {
                        mock_binary_compute(
                            unsafe {
                                core::mem::transmute::<u8, encrypt_types::types::FheOperation>(
                                    n.op_type(),
                                )
                            },
                            &digests[a],
                            &digests[b],
                            ft,
                        )
                    }
                }
                k if k == GraphNodeKind::Output as u8 => digests[n.input_a() as usize],
                _ => panic!("unknown node kind"),
            };
            digests.push(d);
        }

        (0..num)
            .filter(|&i| {
                get_node(pg.node_bytes(), i as u16).unwrap().kind()
                    == GraphNodeKind::Output as u8
            })
            .map(|i| decode_mock_identifier(&digests[i]))
            .collect()
    }

    const U64: FheType = FheType::EUint64;

    // ── match_slot reference vectors ─────────────────────────────────────

    #[test]
    fn match_slot_partial_draw_from_larger_deposit() {
        let out = run_mock(match_slot_graph, &[400_000, 1_000_000], &[U64, U64]);
        assert_eq!(out[0], 0, "remaining drawn to zero");
        assert_eq!(out[1], 600_000, "deposit reduced by 400_000");
        assert_eq!(out[2], 400_000, "coverage = invoice remaining");
    }

    #[test]
    fn match_slot_full_draw_deposit_smaller() {
        let out = run_mock(match_slot_graph, &[1000, 300], &[U64, U64]);
        assert_eq!(out[0], 700, "remaining = 1000 - 300");
        assert_eq!(out[1], 0, "deposit fully drawn");
        assert_eq!(out[2], 300, "coverage = deposit size");
    }

    #[test]
    fn match_slot_empty_slot_no_op() {
        let out = run_mock(match_slot_graph, &[500, 0], &[U64, U64]);
        assert_eq!(out[0], 500);
        assert_eq!(out[1], 0);
        assert_eq!(out[2], 0);
    }

    #[test]
    fn match_slot_full_invoice_no_op() {
        let out = run_mock(match_slot_graph, &[0, 1_000_000], &[U64, U64]);
        assert_eq!(out[0], 0);
        assert_eq!(out[1], 1_000_000, "deposit untouched");
        assert_eq!(out[2], 0);
    }

    // ── apply_reward reference vector ────────────────────────────────────

    #[test]
    fn apply_reward_multiplies_coverage_by_fraction() {
        let out = run_mock(apply_reward_graph, &[1_000_000, 5], &[U64, U64]);
        assert_eq!(out[0], 5_000_000);
    }

    // ── settle reference vectors ─────────────────────────────────────────

    #[test]
    fn settle_full_when_custody_sufficient() {
        let out = run_mock(settle_graph, &[2_000_000, 11_000, 3_000_000], &[U64, U64, U64]);
        assert_eq!(out[0], 1_989_000, "settled = 2M - 11k");
        assert_eq!(out[1], 1_011_000, "new custody = 3M - 1.989M");
    }

    #[test]
    fn settle_masked_when_custody_short() {
        let out = run_mock(settle_graph, &[2_000_000, 11_000, 1_000_000], &[U64, U64, U64]);
        assert_eq!(out[0], 1_000_000, "settled capped at custody");
        assert_eq!(out[1], 0, "custody drained");
    }
}
