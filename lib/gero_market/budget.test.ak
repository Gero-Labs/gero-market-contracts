//// Execution budget of buying several listings in one transaction (spec 5.4 rule 3, 5.11).
////
//// The fee check of every listing walks every listing input of the transaction, so one run of the
//// validator costs more the more listings are bought together, and the whole transaction costs
//// about N times that: it grows with the square of N. These tests measure it.
////
//// Every test builds one transaction that buys N identical listings, as the wallet would:
//// - inputs: the buyer's wallet UTxO first, then the N listings;
//// - outputs: one fee output holding N times the fee, then for each listing its seller output and
////   its royalty outputs, all tagged with that listing's own output reference, then the buyer's
////   change, then one output per listing that delivers the NFT to the buyer.
////
//// A listing is 100 ADA with a 2 ADA deposit, so its fee is the 1.5 ADA minimum and its seller is
//// due 98.5 ADA less its royalties. Unless a test says otherwise a listing has one royalty of 2
//// ADA, paid to a base address (payment and stake key, as most payees have).
////
//// `budget_purchase_n_*` runs the validator for the first listing only, `*_last` for the last one
//// (the dearest: finding its own input and its outputs walks furthest). `budget_baseline_n_*`
//// builds the same transaction and checks its shape without calling the validator. Aiken reports
//// the units of the whole test body, building included, so the baseline is the cost of building
//// and the difference between a purchase test and its baseline is what the validator itself
//// costs.
////
//// Read the units without traces, as the deployed script is built (the default of `aiken build`):
////
////     aiken check -m gero_market/budget -t silent --plain-numbers
////
//// The default of `aiken check` adds traces to the test program, which makes the validator look
//// up to a third dearer than it is. `docs/budget.md` holds the figures and how they are read.

use aiken/collection/list
use cardano/address.{Address, Inline, VerificationKey, from_verification_key}
use cardano/assets.{from_asset, from_lovelace, lovelace_of, merge}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}
use gero_market/fixtures.{
  ada_out, buyer_key, creator_key, fee_addr, listing, listing_input, nft_name,
  nft_policy, other_stake_key, out_ref, seller, tagged_out, tx, v1_fee_bps,
  v1_max_fee, v1_min_fee,
}
use gero_market/spend.{validate}
use gero_market/types.{Listing, Payee, Purchase}

// ## The transaction

const price: Int = 100_000_000

const deposit: Int = 2_000_000

const royalty_each: Int = 2_000_000

/// The v1 fee of a 100 ADA listing: the 1.5 ADA minimum.
const fee_each: Int = 1_500_000

/// A royalty payee: a base address, so its datum carries a stake credential.
const payee_address: Address =
  Address {
    payment_credential: VerificationKey(creator_key),
    stake_credential: Some(Inline(VerificationKey(other_stake_key))),
  }

fn royalties(count: Int) -> List<Payee> {
  list.repeat(Payee { address: payee_address, lovelace: royalty_each }, count)
}

/// The listing every input of the transaction holds.
fn the_listing(royalty_count: Int) -> Listing {
  listing(price, royalties(royalty_count), None)
}

/// What the seller of one listing is due: the price less the fee and the royalties, plus the
/// deposit that goes back to the seller.
fn seller_due(royalty_count: Int) -> Int {
  price - fee_each - royalty_count * royalty_each + deposit
}

/// The buyer's wallet UTxO. It is no listing and its reference is no listing's.
fn buyer_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
      output_index: 0,
    },
    output: ada_out(from_verification_key(buyer_key), 500_000_000),
  }
}

/// A bought NFT delivered to the buyer with 2 ADA.
fn nft_to_buyer() -> Output {
  Output {
    address: from_verification_key(buyer_key),
    value: merge(from_lovelace(deposit), from_asset(nft_policy, nft_name, 1)),
    datum: NoDatum,
    reference_script: None,
  }
}

/// The seller output of the listing at `out_ref(index)` and then its royalty outputs, all tagged.
fn group(index: Int, royalty_count: Int) -> List<Output> {
  [
    tagged_out(seller, seller_due(royalty_count), out_ref(index)),
    ..list.repeat(
      tagged_out(payee_address, royalty_each, out_ref(index)),
      royalty_count,
    )
  ]
}

/// Buys `count` listings with `royalty_count` royalties each.
fn purchase(count: Int, royalty_count: Int) -> Transaction {
  let l = the_listing(royalty_count)
  let indices = list.range(0, count - 1)
  let inputs = [
    buyer_input(),
    ..list.map(indices, fn(i) { listing_input(out_ref(i), l, deposit) })
  ]
  let payments = [
    ada_out(fee_addr, count * fee_each),
    ..list.flat_map(indices, fn(i) { group(i, royalty_count) })
  ]
  let deliveries = list.repeat(nft_to_buyer(), count)
  let change = ada_out(from_verification_key(buyer_key), 400_000_000)
  tx(inputs, list.concat(payments, [change, ..deliveries]), [])
}

/// Where the seller output of the listing at `out_ref(index)` is: after the fee output and the
/// groups of the listings before it.
fn first_output_of(index: Int, royalty_count: Int) -> Int {
  1 + index * ( 1 + royalty_count )
}

// ## What is measured

/// Runs the validator for the listing at `out_ref(index)`, in a transaction that buys `count`
/// listings.
fn run(count: Int, royalty_count: Int, index: Int) -> Bool {
  let l = the_listing(royalty_count)
  validate(
    fee_addr,
    v1_fee_bps,
    v1_min_fee,
    v1_max_fee,
    Some(l),
    Purchase { first_output: first_output_of(index, royalty_count) },
    out_ref(index),
    purchase(count, royalty_count),
  )
}

/// Builds what `run` builds and, instead of calling the validator, compares values read from the
/// result with what they must be: the price of the listing, the buyer's input and the fee output.
///
/// The checks read the head of each list and so cost the same whatever N is. They depend on the
/// lists, and a list exists only once every element is computed (UPLC is strict), so the compiler
/// cannot drop the construction. The baseline is therefore the building and a fixed handful of
/// steps, nothing that grows with N but the building itself.
fn baseline(count: Int, royalty_count: Int) -> Bool {
  let l = the_listing(royalty_count)
  let t = purchase(count, royalty_count)
  expect [first_input, ..] = t.inputs
  expect [first_output, ..] = t.outputs
  and {
    l.price == price,
    first_input.output_reference.output_index == 0,
    lovelace_of(first_output.value) == count * fee_each,
  }
}

// ## N listings, one royalty each: the validator runs for the first listing

test budget_purchase_n_1() {
  run(1, 1, 0)
}

test budget_baseline_n_1() {
  baseline(1, 1)
}

test budget_purchase_n_2() {
  run(2, 1, 0)
}

test budget_baseline_n_2() {
  baseline(2, 1)
}

test budget_purchase_n_5() {
  run(5, 1, 0)
}

test budget_baseline_n_5() {
  baseline(5, 1)
}

test budget_purchase_n_10() {
  run(10, 1, 0)
}

test budget_baseline_n_10() {
  baseline(10, 1)
}

// ## Around the ceiling: one more listing, and the last listing of the largest N that fits

test budget_purchase_n_11() {
  run(11, 1, 0)
}

test budget_baseline_n_11() {
  baseline(11, 1)
}

// Subtract `budget_baseline_n_10`.
test budget_purchase_n_10_last() {
  run(10, 1, 9)
}

// ## One listing with no royalty and with the most royalties the wallet lists (three)

test budget_purchase_n_1_no_royalty() {
  run(1, 0, 0)
}

test budget_baseline_n_1_no_royalty() {
  baseline(1, 0)
}

test budget_purchase_n_1_three_royalties() {
  run(1, 3, 0)
}

test budget_baseline_n_1_three_royalties() {
  baseline(1, 3)
}

// ## N listings with three royalties each, around the ceiling

test budget_purchase_n_7_three_royalties() {
  run(7, 3, 0)
}

test budget_baseline_n_7_three_royalties() {
  baseline(7, 3)
}

// Subtract `budget_baseline_n_7_three_royalties`.
test budget_purchase_n_7_three_royalties_last() {
  run(7, 3, 6)
}

test budget_purchase_n_8_three_royalties() {
  run(8, 3, 0)
}

test budget_baseline_n_8_three_royalties() {
  baseline(8, 3)
}

// Subtract `budget_baseline_n_8_three_royalties`.
test budget_purchase_n_8_three_royalties_last() {
  run(8, 3, 7)
}
