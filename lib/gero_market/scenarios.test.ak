//// Several listings in one transaction, and properties over random listings.
////
//// The ledger runs the validator once for every input at the script, with that input's own datum,
//// output reference and redeemer, against the same transaction. The transaction is valid only if
//// every run passes. `verdicts` does the same here and returns one result per listing input, so a
//// test can say which listing's validator rejects the transaction and which accepts it.
////
//// In every scenario the buyer's own UTxO is the first input, and listings bought together sit at
//// different deposits (2, 3 and 4 ADA). The deposit and the tag of a listing must therefore come
//// from its own output reference, not from the first input or the first listing.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/fuzz
use cardano/address.{Address, Script, from_verification_key}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}
use gero_market/fixtures.{
  ada_out, buyer_key, creator, creator_b, fee_addr, listing, listing_input,
  other_script_hash, out_ref, script_hash, seller, seller_key, stranger_key,
  tagged_out, tx, v1_fee_bps, v1_max_fee, v1_min_fee,
}
use gero_market/spend.{validate}
use gero_market/types.{Action, Cancel, Listing, Payee, Purchase}

// ## The ledger's view of a transaction

/// What each Gero listing input's validator says about the transaction: one verdict per input
/// at the script, in input order, run with the input's own datum, reference and redeemer.
/// Inputs at other addresses run no Gero validator and give no verdict.
fn verdicts(
  inputs: List<Input>,
  redeemers: List<Pair<OutputReference, Action>>,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> List<Bool> {
  let transaction = tx(inputs, outputs, signers)
  inputs
    |> list.filter(
        fn(input) {
          input.output.address.payment_credential == Script(script_hash)
        },
      )
    |> list.map(
        fn(input) {
          expect InlineDatum(raw) = input.output.datum
          expect l: Listing = raw
          expect Some(action) = redeemer_of(redeemers, input.output_reference)
          validate(
            fee_addr,
            v1_fee_bps,
            v1_min_fee,
            v1_max_fee,
            Some(l),
            action,
            input.output_reference,
            transaction,
          )
        },
      )
}

fn redeemer_of(
  redeemers: List<Pair<OutputReference, Action>>,
  ref: OutputReference,
) -> Option<Action> {
  when redeemers is {
    [] -> None
    [Pair(key, action), ..rest] ->
      if key == ref {
        Some(action)
      } else {
        redeemer_of(rest, ref)
      }
  }
}

/// Whether the ledger would accept the transaction: exactly `listings` listings are spent and
/// every one of their validators passes. (Counting them keeps a test from passing because a
/// listing it meant to spend was left out.)
fn accepted(results: List<Bool>, listings: Int) -> Bool {
  listings > 0 && results == list.repeat(True, listings)
}

/// The listing at `out_ref(index)` is bought; its seller output is at `first_output`.
fn bought(index: Int, first_output: Int) -> Pair<OutputReference, Action> {
  Pair(out_ref(index), Purchase { first_output })
}

/// The listing at `out_ref(index)` is cancelled.
fn cancelled(index: Int) -> Pair<OutputReference, Action> {
  Pair(out_ref(index), Cancel)
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

fn fee_out(lovelace: Int) -> Output {
  ada_out(fee_addr, lovelace)
}

fn royalty_of(address: Address, lovelace: Int) -> List<Payee> {
  [Payee { address, lovelace }]
}

const deposit_a: Int = 2_000_000

const deposit_b: Int = 3_000_000

const deposit_c: Int = 4_000_000

// ## One fee output for several listings (rule P3 of docs/rules.md)

// The buy these tests start from. Listing 0 costs 100 ADA with a 2 ADA royalty to the creator and
// a 2 ADA deposit: its fee is the 1.5 ADA minimum and the seller is due 100 - 1.5 - 2 + 2 = 98.5
// ADA. Listing 1 costs 600 ADA with no royalty and a 3 ADA deposit: its fee is the 5 ADA cap and
// the seller is due 600 - 5 + 3 = 598 ADA. The one fee output must hold 6.5 ADA.

fn cheap_listing() -> Listing {
  listing(100_000_000, royalty_of(creator, 2_000_000), None)
}

fn dear_listing() -> Listing {
  listing(600_000_000, [], None)
}

fn bulk_inputs() -> List<Input> {
  [
    buyer_input(),
    listing_input(out_ref(0), cheap_listing(), deposit_a),
    listing_input(out_ref(1), dear_listing(), deposit_b),
  ]
}

fn bulk_redeemers() -> List<Pair<OutputReference, Action>> {
  [bought(0, 1), bought(1, 3)]
}

/// The outputs of the buy: the fee output, then listing 0's seller and royalty, then listing 1's
/// seller. The amounts are parameters so that a test can change one of them.
fn bulk_outputs(fee_paid: Int, seller_0: Int, seller_1: Int) -> List<Output> {
  [
    fee_out(fee_paid),
    tagged_out(seller, seller_0, out_ref(0)),
    tagged_out(creator, 2_000_000, out_ref(0)),
    tagged_out(seller, seller_1, out_ref(1)),
  ]
}

fn bulk_buy(fee_paid: Int) -> List<Bool> {
  verdicts(
    bulk_inputs(),
    bulk_redeemers(),
    bulk_outputs(fee_paid, 98_500_000, 598_000_000),
    [],
  )
}

test two_listings_paid_in_full_pass() {
  accepted(bulk_buy(6_500_000), 2)
}

test two_listings_pass_whatever_the_input_order() {
  let reversed = list.reverse(bulk_inputs())
  let outputs = bulk_outputs(6_500_000, 98_500_000, 598_000_000)
  accepted(verdicts(reversed, bulk_redeemers(), outputs, []), 2)
}

test two_listings_pass_with_their_groups_in_either_output_order() {
  // Listing 1's seller output comes first, then the fee output, then listing 0's seller and
  // royalty: nothing orders one listing's outputs against another's.
  let outputs = [
    tagged_out(seller, 598_000_000, out_ref(1)),
    fee_out(6_500_000),
    tagged_out(seller, 98_500_000, out_ref(0)),
    tagged_out(creator, 2_000_000, out_ref(0)),
  ]
  accepted(
    verdicts(bulk_inputs(), [bought(0, 2), bought(1, 0)], outputs, []),
    2,
  )
}

test fee_of_the_cheaper_listing_alone_fails() {
  // 1.5 ADA is what listing 0 owes. Listing 1 owes 5 ADA more, and each validator checks the sum.
  bulk_buy(1_500_000) == [False, False]
}

test fee_of_the_dearer_listing_alone_fails() {
  bulk_buy(5_000_000) == [False, False]
}

test fee_one_lovelace_short_of_the_sum_fails() {
  bulk_buy(6_499_999) == [False, False]
}

test fee_above_the_sum_passes() {
  accepted(bulk_buy(6_500_001), 2)
}

test fee_may_be_paid_in_two_outputs_to_the_fee_address() {
  // 1.5 + 5 ADA in two outputs: the outputs at the fee address are summed.
  let outputs = list.concat(
    [fee_out(1_500_000)],
    bulk_outputs(5_000_000, 98_500_000, 598_000_000),
  )
  accepted(
    verdicts(bulk_inputs(), [bought(0, 2), bought(1, 4)], outputs, []),
    2,
  )
}

test second_sellers_deposit_cannot_be_replaced_by_the_first() {
  // Listing 1 holds a 3 ADA deposit; paying its seller 597 ADA is paying with listing 0's 2 ADA.
  let outputs = bulk_outputs(6_500_000, 98_500_000, 597_000_000)
  verdicts(bulk_inputs(), bulk_redeemers(), outputs, []) == [True, False]
}

test first_sellers_deposit_cannot_be_dropped() {
  // 96.5 ADA is listing 0's share without the 2 ADA deposit that goes back to its seller.
  let outputs = bulk_outputs(6_500_000, 96_500_000, 598_000_000)
  verdicts(bulk_inputs(), bulk_redeemers(), outputs, []) == [False, True]
}

test three_listings_bought_with_one_fee_output() {
  // Listing 2: 300 ADA, fee 3 ADA, two royalties (2 and 3 ADA), 4 ADA deposit, so its seller is
  // due 300 - 3 - 5 + 4 = 296 ADA. The fee output holds 1.5 + 5 + 3 = 9.5 ADA.
  let third = listing(
    300_000_000,
    [
      Payee { address: creator, lovelace: 2_000_000 },
      Payee { address: creator_b, lovelace: 3_000_000 },
    ],
    None,
  )
  let inputs = [
    buyer_input(),
    listing_input(out_ref(0), cheap_listing(), deposit_a),
    listing_input(out_ref(1), dear_listing(), deposit_b),
    listing_input(out_ref(2), third, deposit_c),
  ]
  let redeemers = [bought(0, 1), bought(1, 3), bought(2, 4)]
  let outputs = fn(fee_paid) {
    [
      fee_out(fee_paid),
      tagged_out(seller, 98_500_000, out_ref(0)),
      tagged_out(creator, 2_000_000, out_ref(0)),
      tagged_out(seller, 598_000_000, out_ref(1)),
      tagged_out(seller, 296_000_000, out_ref(2)),
      tagged_out(creator, 2_000_000, out_ref(2)),
      tagged_out(creator_b, 3_000_000, out_ref(2)),
    ]
  }
  and {
    accepted(verdicts(inputs, redeemers, outputs(9_500_000), []), 3),
    verdicts(inputs, redeemers, outputs(9_499_999), []) == [False, False, False],
  }
}

// ## Listings that try to share an output (rule P4 of docs/rules.md: why the outputs are tagged)

test two_listings_cannot_share_one_seller_output() {
  // Both sellers are the same address, so one output of 100.5 + 101.5 = 202 ADA looks like it
  // pays both. It carries listing 0's tag, so only listing 0's validator accepts it.
  let a = listing(100_000_000, [], None)
  let b = listing(100_000_000, [], None)
  let inputs = [
    buyer_input(),
    listing_input(out_ref(0), a, deposit_a),
    listing_input(out_ref(1), b, deposit_b),
  ]
  let redeemers = [bought(0, 1), bought(1, 1)]
  let shared = fn(tagged_for) {
    [fee_out(3_000_000), tagged_out(seller, 202_000_000, tagged_for)]
  }
  and {
    verdicts(inputs, redeemers, shared(out_ref(0)), []) == [True, False],
    verdicts(inputs, redeemers, shared(out_ref(1)), []) == [False, True],
    verdicts(
      inputs,
      redeemers,
      [fee_out(3_000_000), ada_out(seller, 202_000_000)],
      [],
    ) == [False, False],
  }
}

test two_listings_cannot_share_one_royalty_output() {
  // Both listings point at the same group: output 1 is the seller output and output 2 the
  // royalty output. Each listing owes the creator 2 ADA and its seller 98.5 ADA (listing 0) or
  // 99.5 ADA (listing 1); output 1 holds 198 ADA and output 2 holds 4 ADA, so by amount, address
  // and fee (3 ADA) one group would pay both. Only the tags tell the two apart.
  let a = listing(100_000_000, royalty_of(creator, 2_000_000), None)
  let b = listing(100_000_000, royalty_of(creator, 2_000_000), None)
  let inputs = [
    buyer_input(),
    listing_input(out_ref(0), a, deposit_a),
    listing_input(out_ref(1), b, deposit_b),
  ]
  let redeemers = [bought(0, 1), bought(1, 1)]
  let shared = fn(seller_tag, royalty_tag) {
    [
      fee_out(3_000_000),
      tagged_out(seller, 198_000_000, seller_tag),
      tagged_out(creator, 4_000_000, royalty_tag),
    ]
  }
  and {
    // The seller output is listing 1's: listing 1 passes its seller check and is rejected only
    // because the royalty output carries listing 0's tag. Listing 0 fails on the seller tag.
    verdicts(inputs, redeemers, shared(out_ref(1), out_ref(0)), []) == [
      False, False,
    ],
    // The mirror: the seller output is listing 0's, the royalty output listing 1's.
    verdicts(inputs, redeemers, shared(out_ref(0), out_ref(1)), []) == [
      False, False,
    ],
    // Giving the royalty output the tag of the listing that owns the seller output flips that
    // listing to accepted, so in the two cases above the royalty tag alone decided its verdict.
    verdicts(inputs, redeemers, shared(out_ref(1), out_ref(1)), []) == [
      False, True,
    ],
    verdicts(inputs, redeemers, shared(out_ref(0), out_ref(0)), []) == [
      True, False,
    ],
  }
}

test royalty_output_cannot_double_as_the_next_listings_seller_output() {
  // The creator is also the seller, so one tagged output could pay listing 0's royalty and
  // listing 1's seller if tags allowed it. Output 2 holds 99.5 ADA, which is listing 1's seller
  // due, and 99.5 >= 2: only its tag decides, and it is listing 1's.
  let a = listing(100_000_000, royalty_of(seller, 2_000_000), None)
  let b = listing(100_000_000, royalty_of(seller, 2_000_000), None)
  let inputs = [
    buyer_input(),
    listing_input(out_ref(0), a, deposit_a),
    listing_input(out_ref(1), b, deposit_b),
  ]
  let outputs = [
    fee_out(3_000_000),
    tagged_out(seller, 98_500_000, out_ref(0)),
    tagged_out(seller, 99_500_000, out_ref(1)),
    tagged_out(seller, 2_000_000, out_ref(1)),
  ]
  verdicts(inputs, [bought(0, 1), bought(1, 2)], outputs, []) == [False, True]
}

// ## A cancel and a purchase in one transaction

// Listing 0 (100 ADA, fee 1.5 ADA) is bought; listing 1 (600 ADA, fee 5 ADA) is cancelled by its
// owner. The wallet never builds this, but the fee check counts every input at the script, so
// the fee output must hold the fees of both.

fn mixed_inputs() -> List<Input> {
  [
    buyer_input(),
    listing_input(out_ref(0), listing(100_000_000, [], None), deposit_a),
    listing_input(out_ref(1), dear_listing(), deposit_b),
  ]
}

fn mixed_buy(fee_paid: Int) -> List<Bool> {
  let outputs = [
    fee_out(fee_paid),
    tagged_out(seller, 100_500_000, out_ref(0)),
    ada_out(seller, deposit_b),
  ]
  verdicts(mixed_inputs(), [bought(0, 1), cancelled(1)], outputs, [seller_key])
}

test cancel_and_purchase_with_the_fee_of_the_purchase_only_fails() {
  // The cancel needs no fee and passes; the purchase sees 6.5 ADA due and 1.5 ADA paid.
  mixed_buy(1_500_000) == [False, True]
}

test cancel_and_purchase_with_the_fee_of_the_cancel_only_fails() {
  mixed_buy(5_000_000) == [False, True]
}

test cancel_and_purchase_one_lovelace_short_fails() {
  mixed_buy(6_499_999) == [False, True]
}

test cancel_and_purchase_with_both_fees_pass() {
  accepted(mixed_buy(6_500_000), 2)
}

test cancel_first_then_purchase_needs_both_fees_too() {
  let inputs = [
    buyer_input(),
    listing_input(out_ref(1), dear_listing(), deposit_b),
    listing_input(out_ref(0), listing(100_000_000, [], None), deposit_a),
  ]
  let outputs = fn(fee_paid) {
    [
      fee_out(fee_paid),
      tagged_out(seller, 100_500_000, out_ref(0)),
      ada_out(seller, deposit_b),
    ]
  }
  let redeemers = [cancelled(1), bought(0, 1)]
  and {
    verdicts(inputs, redeemers, outputs(1_500_000), [seller_key]) == [
      True, False,
    ],
    accepted(verdicts(inputs, redeemers, outputs(6_500_000), [seller_key]), 2),
  }
}

// ## Listings of another script are not ours

/// The same UTxO, but at another script (say, another contract version).
fn at_other_script(input: Input) -> Input {
  Input {
    ..input,
    output: Output {
      ..input.output,
      address: Address {
        ..input.output.address,
        payment_credential: Script(other_script_hash),
      },
    },
  }
}

test listing_of_another_script_is_not_counted_toward_the_fee() {
  // A 600 ADA listing of another script hash and a UTxO of that script with no datum sit in the
  // same transaction. They add nothing to the fee due here: 1.5 ADA, the fee of listing 0, is
  // enough. Only the Gero listing has a validator to run.
  let foreign_listing = listing_input(out_ref(1), dear_listing(), deposit_b)
  let foreign_bare = listing_input(out_ref(2), dear_listing(), deposit_c)
  let inputs = [
    buyer_input(),
    listing_input(out_ref(0), listing(100_000_000, [], None), deposit_a),
    at_other_script(foreign_listing),
    at_other_script(
      Input {
        ..foreign_bare,
        output: Output { ..foreign_bare.output, datum: NoDatum },
      },
    ),
  ]
  let outputs = [
    fee_out(1_500_000),
    tagged_out(seller, 100_500_000, out_ref(0)),
  ]
  accepted(verdicts(inputs, [bought(0, 1)], outputs, []), 1)
}

// ## The fee address named by the listing (F2 in docs/threat-model.md)

test fee_address_as_royalty_payee_counts_toward_fee() {
  // The creator's royalty is paid to the fee address, and 2 ADA >= the 1.5 ADA fee, so no
  // separate fee output is needed: every output at the fee address counts toward the fee, whatever
  // else it is for. A.D. Labs still receives at least the fee (here 2 ADA, the royalty). This is
  // deliberate, not an oversight: the royalty and the fee are one payment to one address.
  let l = listing(100_000_000, royalty_of(fee_addr, 2_000_000), None)
  let outputs = [
    tagged_out(seller, 98_500_000, out_ref(0)),
    tagged_out(fee_addr, 2_000_000, out_ref(0)),
  ]
  accepted(
    verdicts(
      [buyer_input(), listing_input(out_ref(0), l, deposit_a)],
      [bought(0, 0)],
      outputs,
      [],
    ),
    1,
  )
}

test fee_address_as_royalty_payee_below_the_fee_fails() {
  // The same listing with a royalty of 1.2 ADA to the fee address: less than the 1.5 ADA fee,
  // and no other output at the fee address, so the fee is not covered.
  let l = listing(100_000_000, royalty_of(fee_addr, 1_200_000), None)
  let outputs = [
    tagged_out(seller, 99_300_000, out_ref(0)),
    tagged_out(fee_addr, 1_200_000, out_ref(0)),
  ]
  verdicts(
    [buyer_input(), listing_input(out_ref(0), l, deposit_a)],
    [bought(0, 0)],
    outputs,
    [],
  ) == [False]
}

test fee_address_as_seller_counts_toward_fee() {
  // A.D. Labs sells an NFT of its own: the seller output is at the fee address, so it is also
  // the fee. A.D. Labs receives the whole price, which is at least the fee.
  let l = Listing { ..listing(100_000_000, [], None), seller_address: fee_addr }
  accepted(
    verdicts(
      [buyer_input(), listing_input(out_ref(0), l, deposit_a)],
      [bought(0, 0)],
      [tagged_out(fee_addr, 100_500_000, out_ref(0))],
      [],
    ),
    1,
  )
}

// ## A private listing in a bulk buy

test private_listing_in_a_bulk_buy_needs_its_buyer() {
  let public = listing(100_000_000, [], None)
  let private = listing(100_000_000, [], Some(buyer_key))
  let inputs = [
    buyer_input(),
    listing_input(out_ref(0), public, deposit_a),
    listing_input(out_ref(1), private, deposit_b),
  ]
  let outputs = [
    fee_out(3_000_000),
    tagged_out(seller, 100_500_000, out_ref(0)),
    tagged_out(seller, 101_500_000, out_ref(1)),
  ]
  let redeemers = [bought(0, 1), bought(1, 2)]
  and {
    verdicts(inputs, redeemers, outputs, []) == [True, False],
    verdicts(inputs, redeemers, outputs, [stranger_key]) == [True, False],
    accepted(verdicts(inputs, redeemers, outputs, [buyer_key]), 2),
  }
}

// ## Properties
//
// Every draw is a purchase of a listing of 5 to 100,000 ADA, with 0 to 3 royalties of 1 to 5 ADA
// and a deposit of 1.5 to 5 ADA, whose seller share is positive: draws that break that are
// redrawn, never skipped. The buyer's UTxO is the first input and 0 to 2 unrelated outputs
// come before the fee output.

type Case {
  price: Int,
  deposit: Int,
  royalties: List<Payee>,
  unrelated_outputs: Int,
}

/// The v1 fee, restated from the schedule instead of calling the contract's fee function: 1% of
/// the price, rounded down, but at least 1.5 ADA and at most 5 ADA.
fn expected_fee(price: Int) -> Int {
  let one_percent = price / 100
  if one_percent < 1_500_000 {
    1_500_000
  } else if one_percent > 5_000_000 {
    5_000_000
  } else {
    one_percent
  }
}

fn royalty_sum(c: Case) -> Int {
  list.foldl(c.royalties, 0, fn(royalty, total) { total + royalty.lovelace })
}

fn seller_share(c: Case) -> Int {
  c.price - expected_fee(c.price) - royalty_sum(c)
}

/// What the seller output must hold: the share plus the deposit that goes back to the seller.
fn seller_due(c: Case) -> Int {
  seller_share(c) + c.deposit
}

/// Prices in three equally likely draws, so that all three ranges of the fee are met: 5 to 40
/// ADA (minimum fee, small shares), 140 to 510 ADA (the thresholds and the proportional band)
/// and the whole 5 to 100,000 ADA (almost always the cap).
fn price_fuzzer() -> Fuzzer<Int> {
  fuzz.either3(
    fuzz.int_between(5_000_000, 40_000_000),
    fuzz.int_between(140_000_000, 510_000_000),
    fuzz.int_between(5_000_000, 100_000_000_000),
  )
}

fn payee_fuzzer() -> Fuzzer<Payee> {
  fuzz.map2(
    fuzz.one_of([creator, creator_b, from_verification_key(stranger_key)]),
    fuzz.int_between(1_000_000, 5_000_000),
    fn(address, lovelace) { Payee { address, lovelace } },
  )
}

/// Between `least` and 3 royalties, every count equally likely.
fn royalties_fuzzer(least: Int) -> Fuzzer<List<Payee>> {
  let count <- fuzz.and_then(fuzz.int_between(least, 3))
  fuzz.list_between(payee_fuzzer(), count, count)
}

/// A case with at least `least` royalties and a positive seller share.
fn case_fuzzer(least: Int) -> Fuzzer<Case> {
  fuzz.map4(
    price_fuzzer(),
    fuzz.int_between(1_500_000, 5_000_000),
    royalties_fuzzer(least),
    fuzz.int_between(0, 2),
    fn(price, deposit, royalties, unrelated_outputs) {
      Case { price, deposit, royalties, unrelated_outputs }
    },
  )
    |> fuzz.such_that(fn(c) { seller_share(c) > 0 })
}

/// Runs the validator on a purchase of the case's listing. The buyer pays `fee_paid` to the fee
/// address, `seller_paid` to the seller and `royalties_paid` to the royalty payees in order.
fn buy(
  c: Case,
  fee_paid: Int,
  seller_paid: Int,
  royalties_paid: List<Int>,
) -> Bool {
  let ref = out_ref(0)
  let l = listing(c.price, c.royalties, None)
  let royalty_outs = list.map2(
    c.royalties,
    royalties_paid,
    fn(royalty, paid) { tagged_out(royalty.address, paid, ref) },
  )
  let unrelated = list.repeat(
    ada_out(from_verification_key(buyer_key), 7_000_000),
    c.unrelated_outputs,
  )
  let outputs = list.concat(
    unrelated,
    [fee_out(fee_paid), tagged_out(seller, seller_paid, ref), ..royalty_outs],
  )
  validate(
    fee_addr,
    v1_fee_bps,
    v1_min_fee,
    v1_max_fee,
    Some(l),
    Purchase { first_output: c.unrelated_outputs + 1 },
    ref,
    tx([buyer_input(), listing_input(ref, l, c.deposit)], outputs, []),
  )
}

fn royalty_amounts(c: Case) -> List<Int> {
  list.map(c.royalties, fn(royalty) { royalty.lovelace })
}

/// Records how the draws spread, for the distribution the test run prints.
fn describe(c: Case) -> Void {
  when list.length(c.royalties) is {
    0 -> fuzz.label(@"0 royalties")
    1 -> fuzz.label(@"1 royalty")
    2 -> fuzz.label(@"2 royalties")
    _ -> fuzz.label(@"3 royalties")
  }
  if c.price < 150_000_000 {
    fuzz.label(@"fee: minimum")
  } else if c.price < 500_000_000 {
    fuzz.label(@"fee: proportional band")
  } else {
    fuzz.label(@"fee: cap")
  }
}

test prop_exact_payment_passes(c via case_fuzzer(0)) {
  describe(c)
  buy(c, expected_fee(c.price), seller_due(c), royalty_amounts(c))
}

test prop_seller_underpaid_fails(c via case_fuzzer(0)) {
  !buy(c, expected_fee(c.price), seller_due(c) - 1, royalty_amounts(c))
}

test prop_fee_underpaid_fails(c via case_fuzzer(0)) {
  !buy(c, expected_fee(c.price) - 1, seller_due(c), royalty_amounts(c))
}

test prop_one_royalty_underpaid_fails(
  drawn via fuzz.both(case_fuzzer(1), fuzz.int_between(0, 2)),
) {
  // Whichever royalty is one lovelace short, in whatever position, the purchase fails.
  let (c, pick) = drawn
  let short = pick % list.length(c.royalties)
  let paid = list.indexed_map(
    royalty_amounts(c),
    fn(index, amount) {
      if index == short {
        amount - 1
      } else {
        amount
      }
    },
  )
  !buy(c, expected_fee(c.price), seller_due(c), paid)
}
