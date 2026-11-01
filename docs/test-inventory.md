# Test inventory of the Gero listing contract

This page maps every rule of [rules.md](rules.md) and every threat of
[threat-model.md](threat-model.md) to the tests that pin it and to the mutation checks that prove
those tests depend on it. Every test name below is a real test of this repository; the names were
checked against the test files on 2026-11-01.

## Running it

```sh
export PATH="<aiken v1.1.24 directory>:$PATH"
npm ci
npm run check                      # aiken fmt --check, aiken check, aiken build (warnings are errors)
npm test                           # the tests of the scripts in scripts/
node scripts/forbidden-words.mjs   # repository hygiene
node scripts/check-vectors.mjs     # the tag vectors, rebuilt without Aiken
node scripts/mutation-check.mjs    # the mutation check below (CI runs it)
```

On the commit measured below, `aiken check` reports 735 checks and 0 errors: 141 Aiken tests, of which
6 are property tests that run 100 times each (135 + 6 x 100). The scripts have 124 tests (`npm test`).
Test modules, all in `lib/gero_market/` unless stated:

| Module | Tests | What it holds |
|---|---|---|
| `tag.test.ak` | 8 | the output tag and its serialisation, for indices 0, 23, 24 and 256 |
| `fee.test.ak` | 13 | the fee formula: boundaries, rounding, cap, no cap, extreme basis points, 2 properties |
| `rules.test.ak` | 30 | `pays`, `pays_each`, `lovelace_paid_to`, `total_fees`, `own_output` |
| `spend.test.ak` | 39 | `Purchase` and `Cancel` of one listing, each failing case breaking exactly one thing |
| `scenarios.test.ak` | 28 | several listings in one transaction, and 4 properties over random listings |
| `budget.test.ak` | 21 | execution-budget measurements (see [budget.md](budget.md)); each also asserts the purchase passes |
| `smoke.test.ak` | 1 | the toolchain runs |
| `validators/listing.ak` | 1 | `else_fails` |

## The mutation check

`scripts/mutation-check.mjs` finds every `// mutant:<id>` marker in the non-test sources, replaces the
one boolean clause below it with `True`, checks that the result compiles, and runs `aiken check`. A
mutant is **killed** only if it compiles and some test then fails (the tool exiting with status
exactly 1, no signal). A mutant that survives, does not compile, or ends in a tool error fails the
script. Property tests run with a fixed seed so a run can be repeated.

Run on 2026-11-01 with Aiken v1.1.24+bacbeb3 on commit `16751b1`, whose contract sources are the ones
this page describes. The output, unedited:

```
id                    | file:line                   | status
----------------------+-----------------------------+-------
pays-address          | lib/gero_market/rules.ak:26 | killed
pays-ada-only         | lib/gero_market/rules.ak:28 | killed
pays-amount           | lib/gero_market/rules.ak:30 | killed
pays-tag              | lib/gero_market/rules.ak:32 | killed
royalty-positive      | lib/gero_market/rules.ak:52 | killed
royalty-paid          | lib/gero_market/rules.ak:54 | killed
royalty-rest          | lib/gero_market/rules.ak:56 | killed
seller-share-positive | lib/gero_market/spend.ak:76 | killed
fee-covered           | lib/gero_market/spend.ak:78 | killed
seller-paid           | lib/gero_market/spend.ak:80 | killed
royalties-paid        | lib/gero_market/spend.ak:82 | killed
buyer-allowed         | lib/gero_market/spend.ak:84 | killed
cancel-owner-signed   | lib/gero_market/spend.ak:89 | killed

13 mutants: 13 killed, 0 survived, 0 compile-error, 0 error (27.1s)
```

### Which tests kill which mutant

Each mutant was applied one at a time on the same commit and the failing tests were listed. This
shows that a clause is protected by tests that are about it, not by an accident.

| Mutant | The clause replaced by `True` | Tests that fail |
|---|---|---|
| `pays-address` | `out.address == address` in `pays` | `pays_other_stake_fails`, `purchase_seller_at_other_stake_fails` |
| `pays-ada-only` | `is_zero(without_lovelace(out.value))` in `pays` | `pays_extra_token_fails`, `purchase_seller_with_token_fails` |
| `pays-amount` | `lovelace_of(out.value) >= amount` in `pays` | `pays_one_below_amount_fails`, `second_sellers_deposit_cannot_be_replaced_by_the_first`, `first_sellers_deposit_cannot_be_dropped`, `prop_seller_underpaid_fails`, `prop_one_royalty_underpaid_fails`, `purchase_seller_one_lovelace_short_fails`, `purchase_seller_paid_without_deposit_fails`, `purchase_royalty_one_lovelace_short_fails`, `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit` |
| `pays-tag` | `out.datum == InlineDatum(tag)` in `pays` | `pays_no_datum_fails`, `pays_hash_datum_fails`, `pays_other_listings_tag_fails`, `two_listings_cannot_share_one_seller_output`, `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `purchase_seller_untagged_fails`, `purchase_cannot_use_the_first_listings_tag` |
| `royalty-positive` | `royalty.lovelace > 0` in `pays_each` | `pays_each_zero_royalty_fails`, `pays_each_negative_royalty_fails`, `pays_each_zero_second_royalty_fails`, `purchase_negative_royalty_fails` |
| `royalty-paid` | `pays(out, royalty.address, royalty.lovelace, tag)` in `pays_each` | `pays_each_swapped_outputs_fails`, `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `prop_one_royalty_underpaid_fails`, `purchase_royalty_one_lovelace_short_fails` |
| `royalty-rest` | `pays_each(others, rest, tag)` in `pays_each` | `pays_each_missing_output_fails`, `pays_each_zero_second_royalty_fails`, `prop_one_royalty_underpaid_fails` |
| `seller-share-positive` | `share > 0` in `validate` | `purchase_seller_share_zero_fails`, `purchase_seller_share_negative_fails` |
| `fee-covered` | `fee_paid >= fee_due` in `validate` | `fee_of_the_cheaper_listing_alone_fails`, `fee_of_the_dearer_listing_alone_fails`, `fee_one_lovelace_short_of_the_sum_fails`, `three_listings_bought_with_one_fee_output`, `cancel_and_purchase_with_the_fee_of_the_purchase_only_fails`, `cancel_and_purchase_with_the_fee_of_the_cancel_only_fails`, `cancel_and_purchase_one_lovelace_short_fails`, `cancel_first_then_purchase_needs_both_fees_too`, `fee_address_as_royalty_payee_below_the_fee_fails`, `prop_fee_underpaid_fails`, `purchase_no_fee_output_fails`, `purchase_fee_one_lovelace_short_fails`, `purchase_fee_at_other_stake_fails`, `purchase_hash_datum_listing_fails` |
| `seller-paid` | `pays(seller_out, l.seller_address, seller_due, tag)` in `validate` | `second_sellers_deposit_cannot_be_replaced_by_the_first`, `first_sellers_deposit_cannot_be_dropped`, `two_listings_cannot_share_one_seller_output`, `two_listings_cannot_share_one_royalty_output`, `prop_seller_underpaid_fails`, `purchase_seller_one_lovelace_short_fails`, `purchase_seller_paid_without_deposit_fails`, `purchase_seller_untagged_fails`, `purchase_seller_with_token_fails`, `purchase_seller_at_other_stake_fails`, `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit` |
| `royalties-paid` | `pays_each(royalty_outs, l.royalties, tag)` in `validate` | `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `prop_one_royalty_underpaid_fails`, `purchase_royalty_missing_fails`, `purchase_royalty_one_lovelace_short_fails`, `purchase_negative_royalty_fails` |
| `buyer-allowed` | `buyer_allowed` in `validate` | `private_listing_in_a_bulk_buy_needs_its_buyer`, `purchase_private_sale_without_signature_fails`, `purchase_private_sale_signed_by_someone_else_fails` |
| `cancel-owner-signed` | `list.has(self.extra_signatories, l.owner)` in `validate` | `cancel_unsigned_fails`, `cancel_signed_by_buyer_only_fails`, `cancel_signed_by_stranger_only_fails`, `cancel_private_listing_by_its_buyer_alone_fails` |

### Two conditions the markers cannot reach

The marker form replaces a whole boolean clause. It cannot reach the condition of an `if`, so two
filter conditions in `rules.ak` carry **no mutant marker**. They are guarded by exact-value tests
instead:

- **The address match in `lovelace_paid_to`** (`if out.address == address`). Pinned by
  `lovelace_paid_to_sums_outputs_at_the_address` and `lovelace_paid_to_ignores_other_stake`, which
  assert the exact sum, and by `purchase_fee_at_other_stake_fails` at the spend level.
- **The own-hash match in `total_fees`** (`if input.output.address.payment_credential == Script(own_hash)`).
  Pinned by `total_fees_ignores_other_script` and `total_fees_ignores_key_address_input`, which assert
  the exact sum when an input is at another script or at a key address, by
  `total_fees_counts_listing_whatever_its_stake` (the match is on the payment part alone), and by
  `listing_of_another_script_is_not_counted_toward_the_fee` at the scenario level.

As a one-off check while this page was written (not part of CI), each condition was replaced by `True`
by hand: 15 and 43 tests failed respectively. `lovelace_paid_to_sums_outputs_at_the_address` and
`lovelace_paid_to_ignores_other_stake` were among the first 15, and `total_fees_ignores_other_script`
and `total_fees_ignores_key_address_input` among the 43.

`fee.ak` has no marker either: it holds no boolean clause. Its minimum, cap and rounding are pinned by
the exact-value `fee_*` tests and restated independently of `listing_fee` by
`prop_exact_payment_passes` and `prop_fee_underpaid_fails`. Hand mutations of it (round half up, round
up, no minimum, cap ignored, cap off by one) each made tests fail in the same one-off check.

### Hash-datum purchases fail closed through one clause

A purchase of a listing with a datum hash is refused only because `total_fees`, called by the
`fee-covered` clause, expects an inline `Listing` in **every** input at the script. No other line
of the purchase path looks at the datum form of the other inputs. The tests that pin the behaviour
are `purchase_hash_datum_listing_fails` (at the spend level, and one of the tests that kill the
`fee-covered` mutant) and `total_fees_hash_datum_fails` (at the rule level), with
`cancel_hash_datum_listing_passes` showing the owner can still cancel it. Narrowing the `fee-covered`
clause to the spent input would make a hash-datum listing buyable, and the first of those tests would
fail.

## Rules to tests

Rule identifiers are those of [rules.md](rules.md).

### D1. A datum is required

- Mutants: none. It is an `expect`, not a clause.
- Tests: `purchase_datum_none_fails`, `cancel_datum_none_fails`.

### P1. The fee

- Mutants: none (see above).
- Tests: `fee_10_ada_is_min`, `fee_100_ada_is_min`, `fee_150_ada_exact`, `fee_151_ada`,
  `fee_rounds_down`, `fee_499_99_ada`, `fee_500_ada_is_cap`, `fee_5000_ada_is_cap`, `fee_no_cap`,
  `fee_bps_1`, `fee_bps_9999`, `prop_fee_within_bounds`, `prop_fee_monotonic`.
- Restated independently: `prop_exact_payment_passes`, `prop_fee_underpaid_fails`.

### P2. The seller's share is positive

- Mutant: `seller-share-positive`.
- Tests: `purchase_seller_share_zero_fails`, `purchase_seller_share_negative_fails`,
  `purchase_seller_share_one_lovelace_passes`.

### P3. The combined fee

- Mutant: `fee-covered`.
- One listing: `purchase_no_fee_output_fails`, `purchase_fee_one_lovelace_short_fails`,
  `purchase_fee_at_other_stake_fails`, `purchase_pays_everyone`.
- Several listings, one fee output: `two_listings_paid_in_full_pass`,
  `two_listings_pass_whatever_the_input_order`, `two_listings_pass_with_their_groups_in_either_output_order`,
  `fee_of_the_cheaper_listing_alone_fails`, `fee_of_the_dearer_listing_alone_fails`,
  `fee_one_lovelace_short_of_the_sum_fails`, `fee_above_the_sum_passes`,
  `fee_may_be_paid_in_two_outputs_to_the_fee_address`, `three_listings_bought_with_one_fee_output`,
  `private_listing_in_a_bulk_buy_needs_its_buyer`.
- A cancel and a purchase in one transaction (the fee covers both):
  `cancel_and_purchase_with_the_fee_of_the_purchase_only_fails`,
  `cancel_and_purchase_with_the_fee_of_the_cancel_only_fails`,
  `cancel_and_purchase_one_lovelace_short_fails`, `cancel_and_purchase_with_both_fees_pass`,
  `cancel_first_then_purchase_needs_both_fees_too`.
- Only listings of this script count: `listing_of_another_script_is_not_counted_toward_the_fee`,
  `total_fees_ignores_other_script`, `total_fees_ignores_key_address_input`,
  `total_fees_counts_listing_whatever_its_stake`.
- The helpers: `lovelace_paid_to_sums_outputs_at_the_address`, `lovelace_paid_to_ignores_other_stake`,
  `lovelace_paid_to_no_outputs_is_zero`, `total_fees_one_listing`, `total_fees_two_listings`.
- Fail closed on any other datum form: `purchase_hash_datum_listing_fails`,
  `total_fees_hash_datum_fails`, `total_fees_no_datum_fails`, `total_fees_foreign_inline_datum_fails`.
- The fee address as payee or seller: `fee_address_as_royalty_payee_counts_toward_fee`,
  `fee_address_as_royalty_payee_below_the_fee_fails`, `fee_address_as_seller_counts_toward_fee`.
- Properties: `prop_fee_underpaid_fails`, `prop_exact_payment_passes`.
- Unmarked conditions (R13): the address match in `lovelace_paid_to` and the own-hash match in
  `total_fees`, as described above.

### P4. A payment to a payee

- Mutants: `pays-address`, `pays-ada-only`, `pays-amount`, `pays-tag`, and `seller-paid` for the
  seller output.
- `pays`: `pays_exact_passes`, `pays_more_than_amount_passes`, `pays_other_stake_fails`,
  `pays_extra_token_fails`, `pays_one_below_amount_fails`, `pays_no_datum_fails`,
  `pays_hash_datum_fails`, `pays_other_listings_tag_fails`.
- The seller output: `purchase_seller_one_lovelace_short_fails`,
  `purchase_seller_paid_without_deposit_fails`, `purchase_seller_untagged_fails`,
  `purchase_seller_with_token_fails`, `purchase_seller_at_other_stake_fails`,
  `prop_seller_underpaid_fails`.
- The deposit and the tag come from the listing's own reference, wherever it is in the inputs:
  `purchase_with_the_buyers_utxo_first_passes`, `cancel_with_the_buyers_utxo_first_passes`,
  `purchase_pays_the_seller_from_its_own_deposit_when_a_dearer_listing_is_first`,
  `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit`,
  `purchase_cannot_use_the_first_listings_tag`, `second_sellers_deposit_cannot_be_replaced_by_the_first`,
  `first_sellers_deposit_cannot_be_dropped`, `own_output_finds_by_reference`,
  `own_output_missing_reference_fails`.

### P5. Where the outputs are

- Mutants: `royalties-paid`, `royalty-positive`, `royalty-paid`, `royalty-rest`.
- `pays_each`: `pays_each_no_royalties_passes`, `pays_each_no_royalties_ignores_extra_outputs`,
  `pays_each_two_royalties_in_order_passes`, `pays_each_swapped_outputs_fails`,
  `pays_each_missing_output_fails`, `pays_each_no_outputs_fails`, `pays_each_zero_royalty_fails`,
  `pays_each_negative_royalty_fails`, `pays_each_zero_second_royalty_fails`.
- The royalty outputs: `purchase_royalty_missing_fails`, `purchase_royalty_one_lovelace_short_fails`,
  `purchase_negative_royalty_fails`, `prop_one_royalty_underpaid_fails`.
- `first_output`: `purchase_seller_output_found_by_index`, `purchase_extra_outputs_after_royalties`,
  `purchase_first_output_past_the_end_fails`,
  `purchase_first_output_minus_one_selects_index_zero_by_design`,
  `purchase_first_output_minus_one_fails_where_index_zero_fails`,
  `two_listings_pass_with_their_groups_in_either_output_order`.

### P6. Private sale

- Mutant: `buyer-allowed`.
- Tests: `purchase_private_sale_with_buyer_signature_passes`,
  `purchase_private_sale_without_signature_fails`,
  `purchase_private_sale_signed_by_someone_else_fails`, `purchase_public_sale_needs_no_signature`,
  `private_listing_in_a_bulk_buy_needs_its_buyer`.

### P7. Where the NFT goes is not checked

- Mutants: none. This is the absence of a rule.
- Tests: `purchase_extra_outputs_after_royalties` delivers the NFT to the buyer in an output after
  the royalties and is accepted. Every scenario test passes with no output for the NFT at all.

### C1. Cancel

- Mutant: `cancel-owner-signed`.
- Tests: `cancel_signed_by_owner_passes`, `cancel_unsigned_fails`, `cancel_signed_by_buyer_only_fails`,
  `cancel_signed_by_stranger_only_fails`, `cancel_private_listing_by_its_buyer_alone_fails`,
  `cancel_private_listing_by_its_owner_passes`, `cancel_hash_datum_listing_passes`,
  `cancel_datum_none_fails`, `cancel_with_the_buyers_utxo_first_passes`. The no-output-rules part
  is shown by every cancel test passing with no outputs at all.

### E1. Nothing but spending

- Mutants: none.
- Test: `else_fails`, in `validators/listing.ak`.

### G1. The tag

- Tests: `serialise_index_0`, `serialise_index_23`, `serialise_index_24`, `serialise_index_256`,
  `tag_index_0`, `tag_index_23`, `tag_index_24`, `tag_index_256`.
- Cross-check: `scripts/check-vectors.mjs` (tested by `scripts/check-vectors.test.mjs`) builds the
  bytes and the tag for each vector of `test-vectors/tags.json` with its own CBOR code and
  `@noble/hashes`, and looks for the same tag in `tag.test.ak`.

## Threats to tests

Threat identifiers are those of [threat-model.md](threat-model.md). "Not testable here" means the
mitigation lives in the wallet or on the chain.

| Id | Tests and mutants |
|---|---|
| T1 | Mutant `pays-tag`. `two_listings_cannot_share_one_seller_output`, `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `purchase_cannot_use_the_first_listings_tag`, `pays_other_listings_tag_fails` |
| T2 | Mutant `fee-covered`. `fee_of_the_cheaper_listing_alone_fails`, `fee_of_the_dearer_listing_alone_fails`, `fee_one_lovelace_short_of_the_sum_fails`, `two_listings_paid_in_full_pass`, `three_listings_bought_with_one_fee_output` |
| T3 | The contract sums one script's listings only: `listing_of_another_script_is_not_counted_toward_the_fee`, `total_fees_ignores_other_script`. The fee address of each version is bound to its version by the deployment tools: `scripts/fee-address-record.test.mjs`, `scripts/apply-params.test.mjs`, `scripts/verify-params.test.mjs` |
| T4 | Mutant `fee-covered`. `purchase_no_fee_output_fails`, `purchase_fee_one_lovelace_short_fails`, `purchase_fee_at_other_stake_fails`, `prop_fee_underpaid_fails`. There is no waiver path to test: no code reads a key, a flag or a datum field that lowers the fee. The parameters are checked by `scripts/apply-params.test.mjs` and `scripts/verify-params.test.mjs` |
| T5 | See the note below. Tests: `fee_above_the_sum_passes`, `purchase_seller_one_lovelace_short_fails`, `second_sellers_deposit_cannot_be_replaced_by_the_first`, `first_sellers_deposit_cannot_be_dropped`, `fee_address_as_seller_counts_toward_fee`, `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit` |
| T6 | Mutant `royalty-positive`. `pays_each_zero_royalty_fails`, `pays_each_negative_royalty_fails`, `pays_each_zero_second_royalty_fails`, `purchase_negative_royalty_fails` |
| T7 | `fee_10_ada_is_min`, `fee_100_ada_is_min`, `prop_fee_within_bounds` (the fee is never below 1.5 ADA). The wallet's `MIN_LIST_PRICE` is not testable here |
| T8 | Not testable here. The contract cannot protect this step |
| T9 | Not testable here |
| T10 | Mutant `pays-ada-only`. `pays_extra_token_fails`, `purchase_seller_with_token_fails` |
| T11 | Not testable here |
| T12 | `purchase_datum_none_fails`, `cancel_datum_none_fails`, `total_fees_no_datum_fails`, `total_fees_foreign_inline_datum_fails` |
| T13 | Not testable here (a property of the ledger and the wallet) |
| T14 | Mutant `cancel-owner-signed`. `cancel_unsigned_fails`, `cancel_signed_by_buyer_only_fails`, `cancel_signed_by_stranger_only_fails` |
| T15 | Every negative `purchase_*` test, and the mutants `fee-covered`, `seller-paid`, `royalties-paid`. The wallet's check of the builder's output is not testable here |
| T16 | `else_fails` |

Note on T5: no single test overpays the fee on one listing while underpaying the seller by the same
amount. The behaviour is pinned indirectly. In the tests above the fee output holds more than one
listing's fee, so a variant that computed the seller's due from the fee actually paid, and not from the
datum, fails `second_sellers_deposit_cannot_be_replaced_by_the_first`,
`first_sellers_deposit_cannot_be_dropped`, `fee_address_as_seller_counts_toward_fee` and
`purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit`. This was checked by hand
(not in CI) on 2026-11-01.

## Review focus

| Focus | Tests |
|---|---|
| Out-ref index of 24 or more | `serialise_index_24`, `serialise_index_256`, `tag_index_24`, `tag_index_256`, and the JavaScript cross-check |
| Listing with a datum hash | `purchase_hash_datum_listing_fails`, `cancel_hash_datum_listing_passes`, `total_fees_hash_datum_fails` |
| Fee address as royalty payee or seller | `fee_address_as_royalty_payee_counts_toward_fee`, `fee_address_as_royalty_payee_below_the_fee_fails`, `fee_address_as_seller_counts_toward_fee` |
| Budget of several listings | `budget_purchase_n_*` and `budget_baseline_n_*` in `budget.test.ak`; the figures and ceilings are in [budget.md](budget.md) |
| Parameter encoding | `scripts/apply-params.test.mjs` and `scripts/verify-params.test.mjs` (two independent implementations must give the same script hash) |

## Tests of the tooling

`npm test` runs 124 tests of the scripts. They are not rules of the contract, but the deployment
depends on them:

| File | What it covers |
|---|---|
| `check-vectors.test.mjs` | the tag cross-check, including bad input |
| `mutation-check.test.mjs` | the mutation script itself: markers, clause parsing, the status of each mutant, restoring the files |
| `forbidden-words.test.mjs`, `is-main.test.mjs`, `test-helpers.test.mjs` | repository hygiene, running the scripts through a symlink, and the shared test helpers |
| `fee-address.test.mjs`, `fee-address-record.test.mjs` | the fee address derivation, and the checks that bind a fee address to its version |
| `apply-params.test.mjs`, `verify-params.test.mjs` | applying the four parameters, refusing a deployed folder, the second implementation and the hash comparison |
| `publish-reference.test.mjs` | the unsigned reference-script transaction, and the refusal of any network but preprod |

## What the tests do not cover

- **The compiled wrapper.** The Aiken tests call the rules directly. No test presents a malformed
  datum, redeemer or script context to the compiled script, which is run only on valid purchases for
  the figures in [budget.md](budget.md).
- **A direct test of T5**, as the note above says.
- **A hash-datum input that is not the one being bought** (for example a listing cancelled in the same
  transaction). It is refused by the same `total_fees` expectation, and `total_fees_hash_datum_fails`
  pins that expectation, but no spend-level test builds the transaction.
- **Reference inputs and the reference-script field of outputs.** The rules do not look at either, and
  no test says so.
- **The wallet.** Everything marked "Wallet" in [threat-model.md](threat-model.md).
