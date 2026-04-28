# FHE Netting on Encrypt

The hub's matching loop is the only piece of HyperSettle that touches encrypted arithmetic. This doc explains what goes inside `#[encrypt_fn]` and how it maps to the blueprint.

## Reference algorithm (from the blueprint)

```
for each deposit in deposits_for(ticker, epoch, up to MAX_DEPOSITS):
    guard    = (remaining > 0) AND (deposit.amount > 0)
    coverage = min(deposit.amount, remaining)
    coverage = guard ? coverage : 0

    discount = min(deposit_age * discount_rate, max_discount)
    reward   = coverage * discount / DISCOUNT_DENOMINATOR

    deposit.amount -= coverage
    remaining      -= coverage
    rewards        += reward

settled_amount = invoice.amount - rewards
require custodied[dest] >= settled_amount
custodied[dest] -= settled_amount
emit Settlement(settled_amount, recipient, dest)
```

Every variable above is either encrypted (`deposit.amount`, `remaining`, `coverage`, `reward`, `rewards`, `settled_amount`, `custodied[...]`, `invoice.amount`) or plaintext (`deposit_age`, `discount_rate`, `max_discount`, `DISCOUNT_DENOMINATOR`, `MAX_DEPOSITS`, `dest`, `recipient`, `ticker`, `epoch`).

## Mapping to Encrypt

The Encrypt `#[encrypt_fn]` macro compiles Rust-like syntax into a DAG of FHE operations. Every branchable path is materialized; `select(cond, a, b)` replaces `if cond { a } else { b }`.

Pseudocode of the Encrypt function signature:

```rust
#[encrypt_fn]
fn match_invoice(
    deposits: &mut [EncAmount; MAX_DEPOSITS],
    deposit_ages: [u32; MAX_DEPOSITS],        // plaintext — time is public
    invoice_amount: EncAmount,
    custodied: &mut EncAmount,
    discount_rate: u32,                       // plaintext
    max_discount: u32,                        // plaintext
    denom: u32,                               // plaintext
) -> (EncAmount /*settled_amount*/, EncAmount /*rewards*/) {
    let mut remaining = invoice_amount;
    let mut rewards: EncAmount = enc_zero();

    for i in 0..MAX_DEPOSITS {
        let dep = deposits[i];
        let guard = enc_and(enc_gt(remaining, enc_zero()), enc_gt(dep, enc_zero()));
        let cov_raw = enc_min(dep, remaining);
        let coverage = enc_select(guard, cov_raw, enc_zero());

        // discount is plaintext per-deposit, so this multiplication is ct * pt
        let disc = plain_min(deposit_ages[i] * discount_rate, max_discount);
        let reward = enc_div_plain(enc_mul_plain(coverage, disc), denom);

        deposits[i] = enc_sub(dep, coverage);
        remaining   = enc_sub(remaining, coverage);
        rewards     = enc_add(rewards, reward);
    }

    let settled = enc_sub(invoice_amount, rewards);
    (settled, rewards)
}
```

Naming above uses `enc_*` as a placeholder for the actual Encrypt API — the exact function names come from the `encrypt-anchor` crate at Phase 2. This doc will be updated when the real names are pinned down.

## Branchless constraints (blueprint Mental Model 2)

- **No encrypted-condition loops.** `MAX_DEPOSITS` is a compile-time constant. Every iteration runs regardless of whether the invoice is already fully settled.
- **No encrypted storage keys.** `ticker` and `epoch` are plaintext, so `deposits[epoch][ticker]` lookup is public.
- **No encrypted control flow.** Every conditional is a `select`.
- **No asserts on encrypted values.** The liquidity check `custodied[dest] >= settled_amount` is performed via encrypted `ge` that returns an `ebool`. If the check fails, the settlement amount is replaced with encrypted zero via `select` — the transaction does not revert (revert on encrypted condition would leak).

## Decryption boundary

The only plaintext that leaves the hub is `settled_amount` at settlement dispatch time. Rewards, partial coverages, and per-deposit updates all stay encrypted forever. This matches blueprint Mental Model 7.

If rewards need to be visible to the rewards recipient, a second decryption request is issued when that recipient claims. No rewards need be decrypted at the moment of netting.
