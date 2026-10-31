//// Tests for the output, royalty and combined-fee rules.
////
//// One test per clause. The tests of `pays` and `pays_each` are written so that every clause
//// marked for the mutation check in `rules.ak` has a test that fails when that clause is
//// replaced by `True`: each failing case below breaks exactly one clause and satisfies the others.

use cardano/address.{Address, Script, from_script}
use cardano/assets.{from_asset, from_lovelace, merge}
use cardano/transaction.{DatumHash, InlineDatum, Input, NoDatum, Output}
use gero_market/fixtures.{
  ada_out, creator, creator_b, fee_addr, fee_addr_other_stake, hash_datum_input,
  listing, listing_input, nft_name, nft_policy, other_script_hash, out_ref,
  script_hash, seller, seller_other_stake, tagged_out,
}
use gero_market/rules.{
  lovelace_paid_to, own_output, pays, pays_each, total_fees,
}
use gero_market/tag.{listing_tag}
use gero_market/types.{Payee}

/// The tag of the listing at `out_ref(0)`, the one the `pays` and `pays_each` tests are about.
fn tag() -> ByteArray {
  listing_tag(out_ref(0))
}

fn v1_total_fees(inputs: List<Input>) -> Int {
  total_fees(inputs, script_hash, 100, 1_500_000, Some(5_000_000))
}

// ## pays

test pays_exact_passes() {
  pays(tagged_out(seller, 98_500_000, out_ref(0)), seller, 98_500_000, tag())
}

test pays_more_than_amount_passes() {
  pays(tagged_out(seller, 98_500_001, out_ref(0)), seller, 98_500_000, tag())
}

test pays_other_stake_fails() {
  !pays(
    tagged_out(seller_other_stake, 98_500_000, out_ref(0)),
    seller,
    98_500_000,
    tag(),
  )
}

test pays_extra_token_fails() {
  let out = Output {
    ..tagged_out(seller, 98_500_000, out_ref(0)),
    value: merge(from_lovelace(98_500_000), from_asset(nft_policy, nft_name, 1)),
  }
  !pays(out, seller, 98_500_000, tag())
}

test pays_one_below_amount_fails() {
  !pays(tagged_out(seller, 98_499_999, out_ref(0)), seller, 98_500_000, tag())
}

test pays_no_datum_fails() {
  !pays(ada_out(seller, 98_500_000), seller, 98_500_000, tag())
}

test pays_hash_datum_fails() {
  let out = Output { ..ada_out(seller, 98_500_000), datum: DatumHash(tag()) }
  !pays(out, seller, 98_500_000, tag())
}

test pays_other_listings_tag_fails() {
  !pays(tagged_out(seller, 98_500_000, out_ref(1)), seller, 98_500_000, tag())
}

// ## pays_each

fn two_royalties() -> List<Payee> {
  [
    Payee { address: creator, lovelace: 2_000_000 },
    Payee { address: creator_b, lovelace: 3_000_000 },
  ]
}

test pays_each_no_royalties_passes() {
  pays_each([], [], tag())
}

test pays_each_no_royalties_ignores_extra_outputs() {
  pays_each([ada_out(seller, 5_000_000)], [], tag())
}

test pays_each_two_royalties_in_order_passes() {
  let outs = [
    tagged_out(creator, 2_000_000, out_ref(0)),
    tagged_out(creator_b, 3_000_000, out_ref(0)),
    ada_out(seller, 5_000_000),
  ]
  pays_each(outs, two_royalties(), tag())
}

test pays_each_swapped_outputs_fails() {
  let outs = [
    tagged_out(creator_b, 3_000_000, out_ref(0)),
    tagged_out(creator, 2_000_000, out_ref(0)),
  ]
  !pays_each(outs, two_royalties(), tag())
}

test pays_each_missing_output_fails() {
  let outs = [tagged_out(creator, 2_000_000, out_ref(0))]
  !pays_each(outs, two_royalties(), tag())
}

test pays_each_no_outputs_fails() {
  !pays_each([], [Payee { address: creator, lovelace: 2_000_000 }], tag())
}

test pays_each_zero_royalty_fails() {
  let outs = [tagged_out(creator, 1_200_000, out_ref(0))]
  !pays_each(outs, [Payee { address: creator, lovelace: 0 }], tag())
}

test pays_each_negative_royalty_fails() {
  let outs = [tagged_out(creator, 1_200_000, out_ref(0))]
  !pays_each(outs, [Payee { address: creator, lovelace: -1 }], tag())
}

test pays_each_zero_second_royalty_fails() {
  let outs = [
    tagged_out(creator, 2_000_000, out_ref(0)),
    tagged_out(creator_b, 1_200_000, out_ref(0)),
  ]
  let royalties = [
    Payee { address: creator, lovelace: 2_000_000 },
    Payee { address: creator_b, lovelace: 0 },
  ]
  !pays_each(outs, royalties, tag())
}

// ## lovelace_paid_to

test lovelace_paid_to_sums_outputs_at_the_address() {
  let outs = [
    ada_out(fee_addr, 1_500_000),
    ada_out(seller, 9_000_000),
    tagged_out(fee_addr, 2_000_000, out_ref(0)),
  ]
  lovelace_paid_to(outs, fee_addr) == 3_500_000
}

test lovelace_paid_to_ignores_other_stake() {
  let outs = [
    ada_out(fee_addr, 1_500_000),
    ada_out(fee_addr_other_stake, 4_000_000),
  ]
  lovelace_paid_to(outs, fee_addr) == 1_500_000
}

test lovelace_paid_to_no_outputs_is_zero() {
  lovelace_paid_to([], fee_addr) == 0
}

// ## total_fees

test total_fees_one_listing() {
  let l = listing(100_000_000, [], None)
  v1_total_fees([listing_input(out_ref(0), l, 2_000_000)]) == 1_500_000
}

test total_fees_two_listings() {
  let cheap = listing(100_000_000, [], None)
  let dear = listing(600_000_000, [], None)
  let inputs = [
    listing_input(out_ref(0), cheap, 2_000_000),
    listing_input(out_ref(1), dear, 2_000_000),
  ]
  v1_total_fees(inputs) == 6_500_000
}

test total_fees_ignores_other_script() {
  let l = listing(100_000_000, [], None)
  let dear = listing(600_000_000, [], None)
  let stranger = listing_input(out_ref(1), dear, 2_000_000)
  let elsewhere = Input {
    ..stranger,
    output: Output {
      ..stranger.output,
      address: Address {
        payment_credential: Script(other_script_hash),
        stake_credential: stranger.output.address.stake_credential,
      },
    },
  }
  v1_total_fees([listing_input(out_ref(0), l, 2_000_000), elsewhere]) == 1_500_000
}

test total_fees_ignores_key_address_input() {
  let l = listing(100_000_000, [], None)
  let wallet_input = Input {
    output_reference: out_ref(1),
    output: ada_out(seller, 50_000_000),
  }
  v1_total_fees([listing_input(out_ref(0), l, 2_000_000), wallet_input]) == 1_500_000
}

test total_fees_counts_listing_whatever_its_stake() {
  let dear = listing(600_000_000, [], None)
  let sitting = listing_input(out_ref(0), dear, 2_000_000)
  let unstaked = Input {
    ..sitting,
    output: Output { ..sitting.output, address: from_script(script_hash) },
  }
  v1_total_fees([listing_input(out_ref(1), dear, 2_000_000), unstaked]) == 10_000_000
}

test total_fees_hash_datum_fails() fail {
  let l = listing(100_000_000, [], None)
  v1_total_fees([hash_datum_input(out_ref(0), l, 2_000_000)]) >= 0
}

test total_fees_no_datum_fails() fail {
  let l = listing(100_000_000, [], None)
  let sitting = listing_input(out_ref(0), l, 2_000_000)
  let bare = Input {
    ..sitting,
    output: Output { ..sitting.output, datum: NoDatum },
  }
  v1_total_fees([bare]) >= 0
}

test total_fees_foreign_inline_datum_fails() fail {
  let l = listing(100_000_000, [], None)
  let sitting = listing_input(out_ref(0), l, 2_000_000)
  let junk = Input {
    ..sitting,
    output: Output { ..sitting.output, datum: InlineDatum(42) },
  }
  v1_total_fees([junk]) >= 0
}

// ## own_output

test own_output_finds_by_reference() {
  let first = listing_input(
    out_ref(0),
    listing(100_000_000, [], None),
    2_000_000,
  )
  let second = listing_input(
    out_ref(1),
    listing(200_000_000, [], None),
    3_000_000,
  )
  own_output([first, second], out_ref(1)) == second.output
}

test own_output_missing_reference_fails() fail {
  let first = listing_input(
    out_ref(0),
    listing(100_000_000, [], None),
    2_000_000,
  )
  own_output([first], out_ref(7)) == first.output
}
