# Test inventory of the Gero listing contract

This page maps every rule of [rules.md](rules.md) and every threat of
[threat-model.md](threat-model.md) to the tests that pin it and to the mutation checks that prove
those tests depend on it. Every test name below is a real test of this repository; the names were
checked against the test files on 2026-11-01, and the context names (`purchase_ok` and the others
in `scripts/eval-applied.mjs`) against `test-vectors/contexts/preprod-v1/`.

## Running it

```sh
export PATH="<aiken v1.1.24 directory>:$PATH"
npm ci
npm run check                      # aiken fmt --check, aiken check, aiken build (warnings are errors)
npm test                           # the tests of the scripts in scripts/
node scripts/forbidden-words.mjs   # repository hygiene
node scripts/check-vectors.mjs     # the tag vectors, rebuilt without Aiken
node scripts/verify-deployments.mjs  # every committed deployment, applied again with Lucid Evolution
node scripts/eval-applied.mjs      # every deployment's applied script on its script contexts
node scripts/mutation-check.mjs    # the mutation check below
```

CI runs all of them. On the commit measured below, `aiken check` reports 762 checks and 0 errors:
168 Aiken tests, of which 6 are property tests that run 100 times each (162 + 6 x 100). The scripts
have 143 tests (`npm test`). Test modules, all in `lib/gero_market/` unless stated:

| Module | Tests | What it holds |
|---|---|---|
| `tag.test.ak` | 8 | the output tag and its serialisation, for indices 0, 23, 24 and 256 |
| `fee.test.ak` | 13 | the fee formula: boundaries, rounding, cap, no cap, extreme basis points, 2 properties |
| `rules.test.ak` | 30 | `pays`, `pays_each`, `lovelace_paid_to`, `total_fees`, `own_output` |
| `spend.test.ak` | 42 | `Purchase` and `Cancel` of one listing, each failing case breaking exactly one thing (one breaks two on purpose: T5) |
| `scenarios.test.ak` | 28 | several listings in one transaction, and 4 properties over random listings |
| `budget.test.ak` | 21 | execution-budget measurements (see [budget.md](budget.md)); each also asserts the purchase passes |
| `contexts.test.ak` | 10 | pins the bytes of the script contexts in `test-vectors/contexts/` |
| `smoke.test.ak` | 1 | the toolchain runs |
| `validators/listing.ak` | 1 | `else_fails` |
| `validators/listing.test.ak` | 14 | the validator's entry point, `listing.spend`, with its four parameters |

## The mutation check

`scripts/mutation-check.mjs` finds every `// mutant:<id>` marker in the non-test sources, replaces the
one boolean clause below it with `True`, checks that the result compiles, and runs `aiken check`. A
mutant is **killed** only if it compiles and some test then fails (the tool exiting with status
exactly 1, no signal). A mutant that survives, does not compile, or ends in a tool error fails the
script. Property tests run with a fixed seed so a run can be repeated.

Run on 2026-11-01 with Aiken v1.1.24+bacbeb3 on a clean checkout of commit `2245c59`, whose contract
sources and tests are the ones this page describes (later commits change only comments and
documentation). The output, unedited:

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

13 mutants: 13 killed, 0 survived, 0 compile-error, 0 error (29.3s)
```

### Which tests kill which mutant

Each mutant was applied one at a time on the same commit and the failing tests were listed. This
shows that a clause is protected by tests that are about it, not by an accident.

| Mutant | The clause replaced by `True` | Tests that fail |
|---|---|---|
| `pays-address` | `out.address == address` in `pays` | `pays_other_stake_fails`, `purchase_seller_at_other_stake_fails` |
| `pays-ada-only` | `is_zero(without_lovelace(out.value))` in `pays` | `pays_extra_token_fails`, `purchase_seller_with_token_fails` |
| `pays-amount` | `lovelace_of(out.value) >= amount` in `pays` | `pays_one_below_amount_fails`, `second_sellers_deposit_cannot_be_replaced_by_the_first`, `first_sellers_deposit_cannot_be_dropped`, `prop_seller_underpaid_fails`, `prop_one_royalty_underpaid_fails`, `purchase_fee_overpaid_cannot_make_up_for_an_underpaid_seller`, `purchase_seller_one_lovelace_short_fails`, `purchase_seller_paid_without_deposit_fails`, `purchase_royalty_one_lovelace_short_fails`, `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit` |
| `pays-tag` | `out.datum == InlineDatum(tag)` in `pays` | `pays_no_datum_fails`, `pays_hash_datum_fails`, `pays_other_listings_tag_fails`, `two_listings_cannot_share_one_seller_output`, `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `purchase_seller_untagged_fails`, `purchase_cannot_use_the_first_listings_tag` |
| `royalty-positive` | `royalty.lovelace > 0` in `pays_each` | `pays_each_zero_royalty_fails`, `pays_each_negative_royalty_fails`, `pays_each_zero_second_royalty_fails`, `purchase_negative_royalty_fails` |
| `royalty-paid` | `pays(out, royalty.address, royalty.lovelace, tag)` in `pays_each` | `pays_each_swapped_outputs_fails`, `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `prop_one_royalty_underpaid_fails`, `purchase_royalty_one_lovelace_short_fails` |
| `royalty-rest` | `pays_each(others, rest, tag)` in `pays_each` | `pays_each_missing_output_fails`, `pays_each_zero_second_royalty_fails`, `prop_one_royalty_underpaid_fails` |
| `seller-share-positive` | `share > 0` in `validate` | `purchase_seller_share_zero_fails`, `purchase_seller_share_negative_fails` |
| `fee-covered` | `fee_paid >= fee_due` in `validate` | `fee_of_the_cheaper_listing_alone_fails`, `fee_of_the_dearer_listing_alone_fails`, `fee_one_lovelace_short_of_the_sum_fails`, `three_listings_bought_with_one_fee_output`, `cancel_and_purchase_with_the_fee_of_the_purchase_only_fails`, `cancel_and_purchase_with_the_fee_of_the_cancel_only_fails`, `cancel_and_purchase_one_lovelace_short_fails`, `cancel_first_then_purchase_needs_both_fees_too`, `fee_address_as_royalty_payee_below_the_fee_fails`, `prop_fee_underpaid_fails`, `purchase_no_fee_output_fails`, `purchase_fee_one_lovelace_short_fails`, `purchase_fee_at_other_stake_fails`, `purchase_hash_datum_listing_fails`, `purchase_next_to_a_cancelled_hash_datum_listing_fails`, `spend_purchase_fee_one_lovelace_short_fails`, `spend_purchase_at_300_ada_pays_one_percent`, `spend_purchase_at_100_ada_pays_the_minimum`, `spend_purchase_at_600_ada_pays_the_cap`, `handler_preprod_v1_purchase_fee_short`, `handler_preprod_v1_purchase_ok_needs_the_deployments_fee_address` |
| `seller-paid` | `pays(seller_out, l.seller_address, seller_due, tag)` in `validate` | `second_sellers_deposit_cannot_be_replaced_by_the_first`, `first_sellers_deposit_cannot_be_dropped`, `two_listings_cannot_share_one_seller_output`, `two_listings_cannot_share_one_royalty_output`, `prop_seller_underpaid_fails`, `purchase_fee_overpaid_cannot_make_up_for_an_underpaid_seller`, `purchase_seller_one_lovelace_short_fails`, `purchase_seller_paid_without_deposit_fails`, `purchase_seller_untagged_fails`, `purchase_seller_with_token_fails`, `purchase_seller_at_other_stake_fails`, `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit` |
| `royalties-paid` | `pays_each(royalty_outs, l.royalties, tag)` in `validate` | `two_listings_cannot_share_one_royalty_output`, `royalty_output_cannot_double_as_the_next_listings_seller_output`, `prop_one_royalty_underpaid_fails`, `purchase_royalty_missing_fails`, `purchase_royalty_one_lovelace_short_fails`, `purchase_negative_royalty_fails` |
| `buyer-allowed` | `buyer_allowed` in `validate` | `private_listing_in_a_bulk_buy_needs_its_buyer`, `purchase_private_sale_without_signature_fails`, `purchase_private_sale_signed_by_someone_else_fails` |
| `cancel-owner-signed` | `list.has(self.extra_signatories, l.owner)` in `validate` | `cancel_unsigned_fails`, `cancel_signed_by_buyer_only_fails`, `cancel_signed_by_stranger_only_fails`, `cancel_private_listing_by_its_buyer_alone_fails`, `spend_cancel_unsigned_fails` |

### Three conditions the markers cannot reach

The marker form replaces a whole boolean clause. It cannot reach the condition of an `if`, nor a
constant arm of a `when`, so three conditions in `rules.ak` carry **no mutant marker**. They are
guarded by exact-value tests instead:

- **The address match in `lovelace_paid_to`** (`if out.address == address`). Pinned by
  `lovelace_paid_to_sums_outputs_at_the_address` and `lovelace_paid_to_ignores_other_stake`, which
  assert the exact sum, and by `purchase_fee_at_other_stake_fails` at the spend level.
- **The own-hash match in `total_fees`** (`if input.output.address.payment_credential == Script(own_hash)`).
  Pinned by `total_fees_ignores_other_script` and `total_fees_ignores_key_address_input`, which assert
  the exact sum when an input is at another script or at a key address, by
  `total_fees_counts_listing_whatever_its_stake` (the match is on the payment part alone), and by
  `listing_of_another_script_is_not_counted_toward_the_fee` at the scenario level.
- **Royalties left with no outputs in `pays_each`** (the `[] -> False` arm of `when outs is`, line 49:
  royalties remain but the outputs have run out). Pinned by `pays_each_missing_output_fails` and
  `pays_each_no_outputs_fails` at the rule level, and by `purchase_royalty_missing_fails` at the
  spend level.

As a one-off check on commit `2245c59` (not part of CI), each condition was replaced by `True` by hand
and `aiken check` run: 21, 48 and 3 tests failed respectively.
`lovelace_paid_to_sums_outputs_at_the_address` and `lovelace_paid_to_ignores_other_stake` were among
the 21; `total_fees_ignores_other_script` and `total_fees_ignores_key_address_input` among the 48;
and the 3 were `pays_each_missing_output_fails`, `pays_each_no_outputs_fails` and
`purchase_royalty_missing_fails`.

`fee.ak` has no marker either: it holds no boolean clause. Its minimum, cap and rounding are pinned by
the exact-value `fee_*` tests and restated independently of `listing_fee` by
`prop_exact_payment_passes` and `prop_fee_underpaid_fails`. Hand mutations of it (round half up, round
up, no minimum, cap ignored, cap off by one) each made tests fail in a one-off check when this page
was first written (on commit `16751b1`).

### Hash-datum purchases fail closed through one clause

A purchase of a listing with a datum hash is refused only because `total_fees`, called by the
`fee-covered` clause, expects an inline `Listing` in **every** input at the script. No other line
of the purchase path looks at the datum form of the other inputs. The tests that pin the behaviour
are `purchase_hash_datum_listing_fails` (the hash-datum listing is the one bought) and
`purchase_next_to_a_cancelled_hash_datum_listing_fails` (an inline listing is bought while a
hash-datum listing of the same script is cancelled in the same transaction), both at the spend level
and both among the tests that kill the `fee-covered` mutant, and `total_fees_hash_datum_fails` at the
rule level. `purchase_next_to_a_cancelled_inline_listing_passes` is the same transaction with the
cancelled listing inline, and `cancel_hash_datum_listing_passes` shows the owner can still cancel a
hash-datum listing. Narrowing the fee due to the spent listing alone was checked by hand (not in CI):
both spend-level tests then fail, with eight scenario tests.

## The entry point and the applied script

The tests above call `validate`. Two more layers run what goes on chain.

**The handler.** `validators/listing.test.ak` calls `listing.spend`, the validator's entry point, with
the version 1 terms written out as numbers. A mistake in how the validator passes its parameters on
gives the same script hash in both parameter implementations, so only these tests can see it.
Swapping `fee_bps` and `min_fee` in the call to `validate` (which would charge 5 ADA on every sale)
passed all 735 checks of commit `32be878`; with these tests it fails six of them
(`spend_purchase_pays_everyone`, `spend_purchase_at_300_ada_pays_one_percent`,
`spend_purchase_at_100_ada_pays_the_minimum`, `handler_preprod_v1_purchase_ok`,
`handler_preprod_v1_purchase_no_royalty`, `handler_preprod_v1_purchase_three_royalties`). Passing
`None` for `max_fee` fails `spend_purchase_at_600_ada_pays_the_cap`. Both were checked by hand, not in
CI. The negative tests cannot see a swap: for any listing that can be bought, the swapped terms give a
fee at least as high as the right one.

| Test | What it shows |
|---|---|
| `spend_purchase_pays_everyone`, `spend_purchase_fee_one_lovelace_short_fails` | a purchase, and the fee one lovelace short |
| `spend_cancel_signed_by_owner_passes`, `spend_cancel_unsigned_fails`, `spend_datum_none_fails` | the cancel and the missing datum |
| `spend_purchase_at_300_ada_pays_one_percent` | the fee comes from `fee_bps` (3 ADA passes, 2.999999 fails) |
| `spend_purchase_at_100_ada_pays_the_minimum` | the fee comes from `min_fee` |
| `spend_purchase_at_600_ada_pays_the_cap` | the fee comes from `max_fee` |
| `handler_preprod_v1_*` | the script contexts of preprod version 1 (below), through the handler, with that deployment's fee address: the same verdicts as the applied script |

**The applied script.** `scripts/eval-applied.mjs` runs `compiledCode` of every committed deployment's
`script.json` (the compiled script with its four parameters applied) on the script contexts in
`test-vectors/contexts/<deployment>/`, with `aiken uplc eval`, and exits 1 on any verdict that is not
the expected one. A context is `cbor.serialise` of a context built by `lib/gero_market/contexts.ak`
with the deployment's own script hash and fee address; `contexts.test.ak` pins its bytes, and the
script refuses a file that is not those bytes or that is not tied to the deployment. CI runs it. Its
output on preprod version 1:

```
deployment | context                  | expected | verdict | memory  | cpu         | error
-----------+--------------------------+----------+---------+---------+-------------+----------------------------------------------------
preprod-v1 | purchase_ok                  | success  | success | 298,562 | 119,908,574 |
preprod-v1 | purchase_no_royalty          | success  | success | 223,756 | 90,225,409  |
preprod-v1 | purchase_three_royalties     | success  | success | 448,174 | 179,274,904 |
preprod-v1 | purchase_fee_short           | failure  | failure | -       | -           | the validator crashed / exited prematurely
preprod-v1 | cancel_ok                    | success  | success | 32,417  | 9,436,911   |
preprod-v1 | cancel_no_datum              | failure  | failure | -       | -           | the validator crashed / exited prematurely
preprod-v1 | cancel_bad_datum             | failure  | failure | -       | -           | failed to deserialise PlutusData using UnConstrData
preprod-v1 | cancel_constr_datum          | success  | success | 32,417  | 9,436,911   |
preprod-v1 | cancel_constr_datum_unsigned | failure  | failure | -       | -           | the validator crashed / exited prematurely
preprod-v1 | purchase_constr_datum        | failure  | failure | -       | -           | the validator crashed / exited prematurely

10 contexts on 1 deployment: 10 as expected, 0 unexpected
```

The deployed script is built without traces, so a failure carries no message of its own; the
`cancel_bad_datum` one comes from the evaluator: a cancel reads the owner from field 0 of the datum,
and an integer has no fields. The purchases are the single buy of [budget.md](budget.md), and their
units are the figures there. A preprod version 1 script rebuilt from the swapped wrapper (checked by
hand, not in CI) fails `purchase_ok`, `purchase_no_royalty` and `purchase_three_royalties`, and the
script exits 1. `scripts/eval-applied.test.mjs` tests the script itself.

The three `*_constr_datum` contexts show how the compiled script treats a datum that is a constructor
but not a `Listing`: here a `Listing` with a sixth field, which Aiken's typed tests cannot build, so
the contexts carry it as raw data. A signed cancel by the key in field 0 passes, at exactly the units
of `cancel_ok` (it reads only that key); the same cancel without the signature fails; and the
purchase of that UTxO, the transaction of `purchase_ok` otherwise, fails. The deployed script is
pinned as it is, not as it might be: see
[F6 of the threat model](threat-model.md#f6-a-datum-that-is-a-constructor-but-not-a-listing). Their
pin tests are `preprod_v1_cancel_constr_datum`, `preprod_v1_cancel_constr_datum_unsigned` and
`preprod_v1_purchase_constr_datum` in `contexts.test.ak`.

## Rules to tests

Rule identifiers are those of [rules.md](rules.md).

### D1. The datum must be a `Listing`

- Mutants: none. It is an `expect` and the wrapper's reading of the datum, not a clause.
- Tests: `purchase_datum_none_fails`, `cancel_datum_none_fails`, and through the handler
  `spend_datum_none_fails`.
- The applied script, in `scripts/eval-applied.mjs`: `cancel_no_datum` (a UTxO with no datum) and
  `cancel_bad_datum` (an inline datum that is the integer 42) must fail. Both are signed cancels by
  the owner, so the datum is the only thing wrong with them. A datum that is a constructor but not a
  `Listing` (`cancel_constr_datum`, `cancel_constr_datum_unsigned`, `purchase_constr_datum`) is
  cancelled by the key in its field 0 and never bought.
- Open question for the audit: should a malformed datum be rejected on `Cancel` too? Today only a
  datum with no readable owner is out of reach of `Cancel`
  ([F6](threat-model.md#f6-a-datum-that-is-a-constructor-but-not-a-listing)).

### P1. The fee

- Mutants: none (see above).
- Tests: `fee_10_ada_is_min`, `fee_100_ada_is_min`, `fee_150_ada_exact`, `fee_151_ada`,
  `fee_rounds_down`, `fee_499_99_ada`, `fee_500_ada_is_cap`, `fee_5000_ada_is_cap`, `fee_no_cap`,
  `fee_bps_1`, `fee_bps_9999`, `prop_fee_within_bounds`, `prop_fee_monotonic`.
- Restated independently: `prop_exact_payment_passes`, `prop_fee_underpaid_fails`.
- Each parameter reaches the fee through the handler: `spend_purchase_at_300_ada_pays_one_percent`
  (`fee_bps`), `spend_purchase_at_100_ada_pays_the_minimum` (`min_fee`),
  `spend_purchase_at_600_ada_pays_the_cap` (`max_fee`).

### P2. The seller's share is positive

- Mutant: `seller-share-positive`.
- Tests: `purchase_seller_share_zero_fails`, `purchase_seller_share_negative_fails`,
  `purchase_seller_share_one_lovelace_passes`.

### P3. The combined fee

- Mutant: `fee-covered`.
- One listing: `purchase_no_fee_output_fails`, `purchase_fee_one_lovelace_short_fails`,
  `purchase_fee_at_other_stake_fails`, `purchase_pays_everyone`; through the handler
  `spend_purchase_pays_everyone`, `spend_purchase_fee_one_lovelace_short_fails` and
  `handler_preprod_v1_purchase_ok_needs_the_deployments_fee_address`; on the applied script,
  `purchase_ok` and `purchase_fee_short` in `scripts/eval-applied.mjs`.
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
  `purchase_next_to_a_cancelled_hash_datum_listing_fails` (with its control
  `purchase_next_to_a_cancelled_inline_listing_passes`), `total_fees_hash_datum_fails`,
  `total_fees_no_datum_fails`, `total_fees_foreign_inline_datum_fails`.
- The fee address as payee or seller: `fee_address_as_royalty_payee_counts_toward_fee`,
  `fee_address_as_royalty_payee_below_the_fee_fails`, `fee_address_as_seller_counts_toward_fee`.
- Properties: `prop_fee_underpaid_fails`, `prop_exact_payment_passes`.
- Unmarked conditions: the address match in `lovelace_paid_to` and the own-hash match in
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
  `prop_seller_underpaid_fails`, `purchase_fee_overpaid_cannot_make_up_for_an_underpaid_seller`.
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
- Unmarked condition: the `[] -> False` arm of `pays_each` (royalties left with no outputs), as
  described above.
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
  `cancel_datum_none_fails`, `cancel_with_the_buyers_utxo_first_passes`; through the handler
  `spend_cancel_signed_by_owner_passes` and `spend_cancel_unsigned_fails`; on the applied script,
  `cancel_ok` and `cancel_constr_datum` (a datum that is not a complete `Listing`, cancelled by the
  key in its field 0, because a cancel reads only the owner) in `scripts/eval-applied.mjs`. The
  no-output-rules part is shown by every cancel test passing with no outputs at all.

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
| T3 | The contract sums one script's listings only: `listing_of_another_script_is_not_counted_toward_the_fee`, `total_fees_ignores_other_script`. The fee address of each version is bound to its version by the deployment tools: `scripts/fee-address-record.test.mjs`, `scripts/apply-params.test.mjs`, `scripts/verify-params.test.mjs`, and on every committed deployment by `scripts/verify-deployments.mjs` (tested by `scripts/verify-deployments.test.mjs`). That a fee address serves only one contract is a deployment rule, not testable here |
| T4 | Mutant `fee-covered`. `purchase_no_fee_output_fails`, `purchase_fee_one_lovelace_short_fails`, `purchase_fee_at_other_stake_fails`, `prop_fee_underpaid_fails`. There is no waiver path to test: no code reads a key, a flag or a datum field that lowers the fee. The parameters are checked by `scripts/apply-params.test.mjs` and `scripts/verify-params.test.mjs`, how the validator passes them on by `validators/listing.test.ak`, and the applied script by `scripts/eval-applied.mjs` (see [above](#the-entry-point-and-the-applied-script)) |
| T5 | Mutants `seller-paid`, `pays-amount`. `purchase_fee_overpaid_cannot_make_up_for_an_underpaid_seller` (the fee output 1 ADA over, the seller output 1 ADA short: refused), with `purchase_seller_one_lovelace_short_fails`, `second_sellers_deposit_cannot_be_replaced_by_the_first`, `first_sellers_deposit_cannot_be_dropped`, `purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit`. See the note below |
| T6 | Mutant `royalty-positive`. `pays_each_zero_royalty_fails`, `pays_each_negative_royalty_fails`, `pays_each_zero_second_royalty_fails`, `purchase_negative_royalty_fails` |
| T7 | `fee_10_ada_is_min`, `fee_100_ada_is_min`, `prop_fee_within_bounds` (the fee is never below 1.5 ADA). The wallet's `MIN_LIST_PRICE` is not testable here |
| T8 | Not testable here. The contract cannot protect this step |
| T9 | Not testable here |
| T10 | Mutant `pays-ada-only`. `pays_extra_token_fails`, `purchase_seller_with_token_fails` |
| T11 | Not testable here |
| T12 | `purchase_datum_none_fails`, `cancel_datum_none_fails`, `spend_datum_none_fails`, `total_fees_no_datum_fails`, `total_fees_foreign_inline_datum_fails`; on the applied script, in `scripts/eval-applied.mjs`: `cancel_no_datum` and `cancel_bad_datum` (an owner's signed cancel of either fails), and `cancel_constr_datum`, `cancel_constr_datum_unsigned` and `purchase_constr_datum` (a datum that is a constructor but not a `Listing`: the owner's signed cancel passes, the unsigned one and the purchase fail) |
| T13 | Not testable here (a property of the ledger and the wallet) |
| T14 | Mutant `cancel-owner-signed`. `cancel_unsigned_fails`, `cancel_signed_by_buyer_only_fails`, `cancel_signed_by_stranger_only_fails`, `spend_cancel_unsigned_fails` |
| T15 | Every negative `purchase_*` test, and the mutants `fee-covered`, `seller-paid`, `royalties-paid`. The wallet's check of the builder's output is not testable here |
| T16 | `else_fails` |

Note on T5: `purchase_fee_overpaid_cannot_make_up_for_an_underpaid_seller` is the direct test. A
variant of `validate` that took the seller's due from the fee actually paid (`price - fee paid -
royalties + deposit`) instead of from the datum was checked by hand on commit `2245c59` (not in CI):
it fails that test, `second_sellers_deposit_cannot_be_replaced_by_the_first`,
`first_sellers_deposit_cannot_be_dropped` and
`purchase_cannot_pay_the_seller_with_the_first_listings_smaller_deposit`.

## Review focus

| Focus | Tests |
|---|---|
| Out-ref index of 24 or more | `serialise_index_24`, `serialise_index_256`, `tag_index_24`, `tag_index_256`, and the JavaScript cross-check |
| Listing with a datum hash | `purchase_hash_datum_listing_fails`, `purchase_next_to_a_cancelled_hash_datum_listing_fails`, `cancel_hash_datum_listing_passes`, `total_fees_hash_datum_fails` |
| Fee address as royalty payee or seller | `fee_address_as_royalty_payee_counts_toward_fee`, `fee_address_as_royalty_payee_below_the_fee_fails`, `fee_address_as_seller_counts_toward_fee` |
| Budget of several listings | `budget_purchase_n_*` and `budget_baseline_n_*` in `budget.test.ak`; the figures and ceilings are in [budget.md](budget.md) |
| Datum that is a constructor but not a `Listing` | `cancel_constr_datum`, `cancel_constr_datum_unsigned`, `purchase_constr_datum` in `scripts/eval-applied.mjs`; strict rejection is an open question for the audit ([F6](threat-model.md#f6-a-datum-that-is-a-constructor-but-not-a-listing)) |
| Parameter encoding | `scripts/apply-params.test.mjs` and `scripts/verify-params.test.mjs` (two independent implementations must give the same script hash); `scripts/verify-deployments.mjs` on every committed deployment; `validators/listing.test.ak` and `scripts/eval-applied.mjs` for the order in which the validator passes its parameters on |

## Tests of the tooling

`npm test` runs 143 tests of the scripts. They are not rules of the contract, but the deployment
depends on them:

| File | What it covers |
|---|---|
| `check-vectors.test.mjs` | the tag cross-check, including bad input |
| `mutation-check.test.mjs` | the mutation script itself: markers, clause parsing, the status of each mutant, restoring the files |
| `forbidden-words.test.mjs`, `is-main.test.mjs`, `test-helpers.test.mjs` | repository hygiene, running the scripts through a symlink, and the shared test helpers |
| `fee-address.test.mjs`, `fee-address-record.test.mjs` | the fee address derivation, and the checks that bind a fee address to its version |
| `apply-params.test.mjs`, `verify-params.test.mjs` | applying the four parameters, refusing a deployed folder, the second implementation and the hash comparison |
| `publish-reference.test.mjs` | the unsigned reference-script transaction, and the refusal of any network but preprod |
| `verify-deployments.test.mjs` | `verify-params` over every committed deployment: folders still being prepared left out, every folder checked, the worst result wins |
| `eval-applied.test.mjs` | the CBOR reader, the pins, the tie of a context to its deployment, the verdicts, and the committed deployment's units (the single-buy figures of [budget.md](budget.md)) |

## What the tests do not cover

- **More of the compiled wrapper.** The applied script runs on ten script contexts, among them a
  missing datum, a datum that is the integer 42 and a `Listing` with a sixth field. Only that one
  malformed constructor is pinned; the other wrong shapes (another constructor index, a price that
  is bytes, a buyer that is an integer, the owner field alone) were tried by hand on the preprod
  version 1 script and behave the same, but no context holds them. No context carries a malformed
  redeemer, or a script context of another shape (another purpose reaches `else`, which `else_fails`
  tests as a function only).
- **Strict rejection of malformed datums.** The tests pin what the deployed script does: a datum that
  is a constructor but not a `Listing` can be cancelled by the key in its field 0 and never bought.
  Whether the contract should reject such a datum on `Cancel` as well is an open question for the
  audit ([F6](threat-model.md#f6-a-datum-that-is-a-constructor-but-not-a-listing)); no test asserts
  either answer beyond the current behaviour.
- **The budget of several listings on the applied script.** Only the single buy is re-run in CI; the
  figures for several listings in [budget.md](budget.md) were measured once, by hand.
- **Reference inputs and the reference-script field of outputs.** The rules do not look at either, and
  no test says so.
- **The wallet.** Everything marked "Wallet" in [threat-model.md](threat-model.md).
