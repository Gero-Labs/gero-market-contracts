//// Tests for the spend validation: `Purchase` and `Cancel` of one listing.
////
//// Every listing here costs 100 ADA, sits with a 2 ADA deposit and owes one 2 ADA royalty to
//// the creator. With the v1 parameters the fee is 1.5 ADA (the minimum), so the seller is due
//// 100 - 1.5 - 2 + 2 = 98.5 ADA. Each failing case starts from the passing purchase and
//// breaks exactly one thing, so it fails for the reason its name gives. That is what lets the
//// mutation check tie each marked clause of `spend.ak` to a test.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{from_verification_key}
use cardano/assets.{from_asset, from_lovelace, merge}
use cardano/transaction.{Input, Output}
use gero_market/fixtures.{
  ada_out, buyer_key, creator, fee_addr, fee_addr_other_stake, hash_datum_input,
  listing, listing_input, nft_name, nft_policy, out_ref, seller, seller_key,
  seller_other_stake, stranger_key, tagged_out, tx, v1_fee_bps, v1_max_fee,
  v1_min_fee,
}
use gero_market/spend.{validate}
use gero_market/types.{Action, Cancel, Listing, Payee, Purchase}

/// The deposit every listing UTxO holds next to its NFT.
const deposit: Int = 2_000_000

/// The one royalty of the fixture listings: 2 ADA to the creator.
fn royalty() -> List<Payee> {
  [Payee { address: creator, lovelace: 2_000_000 }]
}

/// The public 100 ADA listing the tests start from.
fn base() -> Listing {
  listing(100_000_000, royalty(), None)
}

/// The v1 validator run on the listing at `out_ref(0)` with the given datum, action, inputs,
/// outputs and signers.
fn run(
  datum: Option<Listing>,
  action: Action,
  inputs: List<Input>,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Bool {
  validate(
    fee_addr,
    v1_fee_bps,
    v1_min_fee,
    v1_max_fee,
    datum,
    action,
    out_ref(0),
    tx(inputs, outputs, signers),
  )
}

/// A purchase of `l` whose listing UTxO is the only input.
fn purchase(
  l: Listing,
  first_output: Int,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Bool {
  run(
    Some(l),
    Purchase { first_output },
    [listing_input(out_ref(0), l, deposit)],
    outputs,
    signers,
  )
}

/// A cancel of `l` whose listing UTxO is the only input and that pays nobody.
fn cancel(l: Listing, signers: List<VerificationKeyHash>) -> Bool {
  run(Some(l), Cancel, [listing_input(out_ref(0), l, deposit)], [], signers)
}

/// The fee output of a correct purchase of `base()`: 1.5 ADA, the minimum fee.
fn fee_out() -> Output {
  ada_out(fee_addr, 1_500_000)
}

/// The seller output of a correct purchase of `base()`: 98.5 ADA, tagged.
fn seller_out() -> Output {
  tagged_out(seller, 98_500_000, out_ref(0))
}

/// The royalty output of a correct purchase of `base()`: 2 ADA to the creator, tagged.
fn royalty_out() -> Output {
  tagged_out(creator, 2_000_000, out_ref(0))
}

/// The outputs of a correct purchase of `base()`. The seller output is at index 1.
fn good_outputs() -> List<Output> {
  [fee_out(), seller_out(), royalty_out()]
}

// ## Purchase: what a correct purchase looks like

test purchase_pays_everyone() {
  purchase(base(), 1, good_outputs(), [])
}

test purchase_extra_outputs_after_royalties() {
  let nft_to_buyer = Output {
    ..ada_out(from_verification_key(buyer_key), 2_000_000),
    value: merge(from_lovelace(2_000_000), from_asset(nft_policy, nft_name, 1)),
  }
  let change = ada_out(from_verification_key(buyer_key), 7_000_000)
  purchase(base(), 1, list.concat(good_outputs(), [nft_to_buyer, change]), [])
}

test purchase_seller_output_found_by_index() {
  let outputs = [ada_out(creator, 9_000_000), ..good_outputs()]
  purchase(base(), 2, outputs, [])
}

// ## Purchase: the combined fee (fee-covered)

test purchase_no_fee_output_fails() {
  !purchase(base(), 0, [seller_out(), royalty_out()], [])
}

test purchase_fee_one_lovelace_short_fails() {
  let outputs = [ada_out(fee_addr, 1_499_999), seller_out(), royalty_out()]
  !purchase(base(), 1, outputs, [])
}

test purchase_fee_at_other_stake_fails() {
  let outputs = [
    ada_out(fee_addr_other_stake, 1_500_000),
    seller_out(),
    royalty_out(),
  ]
  !purchase(base(), 1, outputs, [])
}

// ## Purchase: the seller's share (seller-paid)

test purchase_seller_one_lovelace_short_fails() {
  let outputs = [
    fee_out(),
    tagged_out(seller, 98_499_999, out_ref(0)),
    royalty_out(),
  ]
  !purchase(base(), 1, outputs, [])
}

test purchase_seller_paid_without_deposit_fails() {
  let outputs = [
    fee_out(),
    tagged_out(seller, 96_500_000, out_ref(0)),
    royalty_out(),
  ]
  !purchase(base(), 1, outputs, [])
}

test purchase_seller_untagged_fails() {
  let outputs = [fee_out(), ada_out(seller, 98_500_000), royalty_out()]
  !purchase(base(), 1, outputs, [])
}

test purchase_seller_with_token_fails() {
  let with_token = Output {
    ..seller_out(),
    value: merge(from_lovelace(98_500_000), from_asset(nft_policy, nft_name, 1)),
  }
  !purchase(base(), 1, [fee_out(), with_token, royalty_out()], [])
}

test purchase_seller_at_other_stake_fails() {
  let outputs = [
    fee_out(),
    tagged_out(seller_other_stake, 98_500_000, out_ref(0)),
    royalty_out(),
  ]
  !purchase(base(), 1, outputs, [])
}

// ## Purchase: royalties (royalties-paid)

test purchase_royalty_missing_fails() {
  !purchase(base(), 1, [fee_out(), seller_out()], [])
}

test purchase_royalty_one_lovelace_short_fails() {
  let outputs = [
    fee_out(),
    seller_out(),
    tagged_out(creator, 1_999_999, out_ref(0)),
  ]
  !purchase(base(), 1, outputs, [])
}

test purchase_negative_royalty_fails() {
  // A negative royalty would raise the seller's due to 100 - 1.5 + 1 + 2 = 101.5 ADA, above
  // the price the listing advertises. Every output below is fine for that datum.
  let l = listing(
    100_000_000,
    [Payee { address: creator, lovelace: -1_000_000 }],
    None,
  )
  let outputs = [
    fee_out(),
    tagged_out(seller, 101_500_000, out_ref(0)),
    tagged_out(creator, 1_200_000, out_ref(0)),
  ]
  !purchase(l, 1, outputs, [])
}

// ## Purchase: the seller's share must be positive (seller-share-positive)

test purchase_seller_share_zero_fails() {
  // 3.5 - 1.5 fee - 2 royalty = 0, so the seller is due only the 2 ADA deposit.
  let l = listing(3_500_000, royalty(), None)
  let outputs = [
    fee_out(),
    tagged_out(seller, 2_000_000, out_ref(0)),
    royalty_out(),
  ]
  !purchase(l, 1, outputs, [])
}

test purchase_seller_share_negative_fails() {
  // 3 - 1.5 fee - 2 royalty = -0.5, so the seller would be due 1.5 ADA.
  let l = listing(3_000_000, royalty(), None)
  let outputs = [
    fee_out(),
    tagged_out(seller, 1_500_000, out_ref(0)),
    royalty_out(),
  ]
  !purchase(l, 1, outputs, [])
}

test purchase_seller_share_one_lovelace_passes() {
  // 3.500001 - 1.5 fee - 2 royalty = 1 lovelace, plus the 2 ADA deposit.
  let l = listing(3_500_001, royalty(), None)
  let outputs = [
    fee_out(),
    tagged_out(seller, 2_000_001, out_ref(0)),
    royalty_out(),
  ]
  purchase(l, 1, outputs, [])
}

// ## Purchase: private sale (buyer-allowed)

test purchase_private_sale_with_buyer_signature_passes() {
  let l = listing(100_000_000, royalty(), Some(buyer_key))
  purchase(l, 1, good_outputs(), [buyer_key])
}

test purchase_private_sale_without_signature_fails() {
  let l = listing(100_000_000, royalty(), Some(buyer_key))
  !purchase(l, 1, good_outputs(), [])
}

test purchase_private_sale_signed_by_someone_else_fails() {
  let l = listing(100_000_000, royalty(), Some(buyer_key))
  !purchase(l, 1, good_outputs(), [stranger_key])
}

test purchase_public_sale_needs_no_signature() {
  purchase(base(), 1, good_outputs(), [stranger_key])
}

// ## Purchase: inputs the validator refuses outright

test purchase_first_output_past_the_end_fails() fail {
  purchase(base(), 3, good_outputs(), [])
}

test purchase_datum_none_fails() fail {
  run(
    None,
    Purchase { first_output: 1 },
    [listing_input(out_ref(0), base(), deposit)],
    good_outputs(),
    [],
  )
}

test purchase_hash_datum_listing_fails() fail {
  // The ledger resolves a datum hash from the witness set and passes `Some(l)`, so the spent
  // UTxO itself passes the datum check. The combined fee still has to read the datum of every
  // input at the script, and a hash is not an inline `Listing`: the purchase cannot proceed.
  // The same outputs buy the inline-datum listing in `purchase_pays_everyone`.
  let l = base()
  run(
    Some(l),
    Purchase { first_output: 1 },
    [hash_datum_input(out_ref(0), l, deposit)],
    good_outputs(),
    [],
  )
}

// ## Cancel (cancel-owner-signed)

test cancel_signed_by_owner_passes() {
  cancel(base(), [seller_key])
}

test cancel_unsigned_fails() {
  !cancel(base(), [])
}

test cancel_signed_by_buyer_only_fails() {
  !cancel(base(), [buyer_key])
}

test cancel_signed_by_stranger_only_fails() {
  !cancel(base(), [stranger_key])
}

test cancel_datum_none_fails() fail {
  run(
    None,
    Cancel,
    [listing_input(out_ref(0), base(), deposit)],
    [],
    [seller_key],
  )
}

test cancel_hash_datum_listing_passes() {
  // Datum-hash listings can never be bought, but the owner can always take them back.
  let l = base()
  run(
    Some(l),
    Cancel,
    [hash_datum_input(out_ref(0), l, deposit)],
    [],
    [seller_key],
  )
}
