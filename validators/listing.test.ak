//// Tests of the validator's entry point: `listing.spend`, with its four parameters, which is what
//// the compiled script runs.
////
//// The tests of `lib/gero_market/` call `validate` directly. These call the handler instead, so a
//// mistake in how `validators/listing.ak` passes its parameters on (two of them swapped, a cap
//// dropped) makes a test here fail. They use the version 1 terms written out as numbers (100,
//// 1_500_000 and `Some(5_000_000)`), as a deployment applies them.
////
//// The second half runs the deployment contexts of `contexts.ak` through the same handler with the
//// fee address of their deployment. `scripts/eval-applied.mjs` runs the very same contexts through
//// the compiled, applied script of that deployment and expects the same verdicts.

use cardano/transaction.{Input, Output, OutputReference, Transaction}
use gero_market/contexts.{
  Deployment, Spend, cancel_ok, preprod_v1, purchase_fee_short,
  purchase_no_royalty, purchase_ok, purchase_three_royalties,
}
use gero_market/fixtures.{
  ada_out, creator, fee_addr, listing, listing_input, out_ref, seller,
  seller_key, tagged_out, tx,
}
use gero_market/types.{Action, Cancel, Listing, Payee, Purchase}
use listing

/// The deposit of every listing below.
const deposit: Int = 2_000_000

/// The handler with the version 1 terms and the fixture fee address.
fn spend(
  datum: Option<Listing>,
  action: Action,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  listing.listing.spend(
    fee_addr,
    100,
    1_500_000,
    Some(5_000_000),
    datum,
    action,
    own_ref,
    self,
  )
}

/// A purchase of `l`, the only input, sitting at `out_ref(0)` with the deposit.
fn purchase(l: Listing, outputs: List<Output>) -> Bool {
  spend(
    Some(l),
    Purchase { first_output: 1 },
    out_ref(0),
    tx([listing_input(out_ref(0), l, deposit)], outputs, []),
  )
}

fn input(l: Listing) -> List<Input> {
  [listing_input(out_ref(0), l, deposit)]
}

/// A 100 ADA listing with one 2 ADA royalty to the creator.
fn with_royalty() -> Listing {
  listing(100_000_000, [Payee { address: creator, lovelace: 2_000_000 }], None)
}

/// The outputs that buy `with_royalty()` when the fee output holds `fee`: the seller is due
/// 100 - 1.5 - 2 + 2 = 98.5 ADA.
fn outputs_with_royalty(fee: Int) -> List<Output> {
  [
    ada_out(fee_addr, fee),
    tagged_out(seller, 98_500_000, out_ref(0)),
    tagged_out(creator, 2_000_000, out_ref(0)),
  ]
}

/// The outputs that buy a listing with no royalty at `price`, whose fee is `fee`, when the fee
/// output holds `paid`.
fn outputs_no_royalty(price: Int, fee: Int, paid: Int) -> List<Output> {
  [
    ada_out(fee_addr, paid),
    tagged_out(seller, price - fee + deposit, out_ref(0)),
  ]
}

// ## Purchase and cancel through the handler

test spend_purchase_pays_everyone() {
  purchase(with_royalty(), outputs_with_royalty(1_500_000))
}

test spend_purchase_fee_one_lovelace_short_fails() {
  !purchase(with_royalty(), outputs_with_royalty(1_499_999))
}

test spend_cancel_signed_by_owner_passes() {
  spend(
    Some(with_royalty()),
    Cancel,
    out_ref(0),
    tx(input(with_royalty()), [], [seller_key]),
  )
}

test spend_cancel_unsigned_fails() {
  !spend(
    Some(with_royalty()),
    Cancel,
    out_ref(0),
    tx(input(with_royalty()), [], []),
  )
}

test spend_datum_none_fails() fail {
  spend(None, Cancel, out_ref(0), tx(input(with_royalty()), [], [seller_key]))
}

// ## Each parameter reaches the fee

test spend_purchase_at_300_ada_pays_one_percent() {
  // 1% of 300 ADA is 3 ADA, between the minimum and the cap, so the fee comes from `fee_bps`
  // alone. With `fee_bps` and `min_fee` swapped the fee would be min(max(300 ADA x 150, 100), 5
  // ADA) = 5 ADA, and the 3 ADA fee output would be refused.
  let l = listing(300_000_000, [], None)
  and {
    purchase(l, outputs_no_royalty(300_000_000, 3_000_000, 3_000_000)),
    !purchase(l, outputs_no_royalty(300_000_000, 3_000_000, 2_999_999)),
  }
}

test spend_purchase_at_100_ada_pays_the_minimum() {
  // 1% of 100 ADA is 1 ADA, below the 1.5 ADA minimum, so the fee comes from `min_fee`.
  let l = listing(100_000_000, [], None)
  and {
    purchase(l, outputs_no_royalty(100_000_000, 1_500_000, 1_500_000)),
    !purchase(l, outputs_no_royalty(100_000_000, 1_500_000, 1_499_999)),
  }
}

test spend_purchase_at_600_ada_pays_the_cap() {
  // 1% of 600 ADA is 6 ADA, above the 5 ADA cap, so the fee comes from `max_fee`. Without the cap
  // the 5 ADA fee output would be refused.
  let l = listing(600_000_000, [], None)
  and {
    purchase(l, outputs_no_royalty(600_000_000, 5_000_000, 5_000_000)),
    !purchase(l, outputs_no_royalty(600_000_000, 5_000_000, 4_999_999)),
  }
}

// ## The contexts of deployments/preprod-v1, through the handler

/// The handler with the version 1 terms and the fee address of `d`.
fn run(d: Deployment, s: Spend) -> Bool {
  listing.listing.spend(
    d.fee_address,
    100,
    1_500_000,
    Some(5_000_000),
    Some(s.listing),
    s.action,
    s.own_ref,
    s.transaction,
  )
}

test handler_preprod_v1_purchase_ok() {
  run(preprod_v1, purchase_ok(preprod_v1))
}

test handler_preprod_v1_purchase_no_royalty() {
  run(preprod_v1, purchase_no_royalty(preprod_v1))
}

test handler_preprod_v1_purchase_three_royalties() {
  run(preprod_v1, purchase_three_royalties(preprod_v1))
}

test handler_preprod_v1_purchase_fee_short() {
  !run(preprod_v1, purchase_fee_short(preprod_v1))
}

test handler_preprod_v1_cancel_ok() {
  run(preprod_v1, cancel_ok(preprod_v1))
}

test handler_preprod_v1_purchase_ok_needs_the_deployments_fee_address() {
  // The same transaction judged with the fixture fee address: its fee output is at another
  // address, so it pays no fee.
  !listing.listing.spend(
    fee_addr,
    100,
    1_500_000,
    Some(5_000_000),
    Some(purchase_ok(preprod_v1).listing),
    purchase_ok(preprod_v1).action,
    purchase_ok(preprod_v1).own_ref,
    purchase_ok(preprod_v1).transaction,
  )
}
