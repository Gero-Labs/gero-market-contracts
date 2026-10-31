# Execution budget of the Gero listing contract

Measured on 2026-10-31 with Aiken v1.1.24 (validator source as of commit `69cc351`), against the
mainnet transaction limits of epoch 665.

## In short

- **Buying several listings in one transaction costs more than the sum of single buys.** Every
  listing's validator walks every listing input of the transaction (spec 5.4 rule 3), so the cost
  of the transaction grows with the square of the number of listings.
- **Bulk-buy ceiling: 10 listings** when each has at most one royalty and the buyer pays from one
  wallet UTxO. That uses 76.0% of the memory limit and 49.4% of the CPU limit. Eleven listings use
  90.7% of the memory limit. With three royalties per listing the ceiling is 7.
- **A single buy costs about 300,000 memory units and 120 million CPU steps** with one royalty
  (1.8% and 1.2% of the limits), about 0.026 ADA of execution fee. With no royalty it is about
  224,000 and 90 million, with three royalties about 448,000 and 179 million.
- **Memory is the limit that binds**, not CPU.

## The limits

Read from Koios `epoch_params` (no API key) on 2026-10-31, epoch 665.

| Parameter | Value | 80% of it |
|---|---|---|
| Max transaction memory (`max_tx_ex_mem`) | 16,500,000 | 13,200,000 |
| Max transaction CPU steps (`max_tx_ex_steps`) | 10,000,000,000 | 8,000,000,000 |
| Max transaction size (`max_tx_size`) | 16,384 bytes | not measured |
| Price per memory unit / per CPU step | 0.0577 / 0.0000721 lovelace | |

## How the figures were obtained

**The tests.** `lib/gero_market/budget.test.ak` builds one transaction that buys N identical
listings, as the wallet would: the buyer's wallet UTxO first and then the N listings as inputs;
one fee output holding N times the fee, then for each listing its seller output and its royalty
outputs (each tagged with that listing's own output reference), the buyer's change, and one output
per listing that delivers the NFT. A listing is 100 ADA with a 2 ADA deposit and, unless stated,
one royalty of 2 ADA paid to a base address. `budget_purchase_n_N` runs the validator for the
first listing of that transaction.

Aiken reports the units of the whole test, including the work of building the transaction, so
each purchase test has a matching `budget_baseline_n_N` that builds the same transaction and checks
its shape without running the validator. **The validator's own cost is the purchase test minus its
baseline.** The baseline reads the head of each list, which forces the whole transaction to be
built (a list exists only once every element is computed) at a cost that does not depend on N.
The baselines grow by about 77,000 memory units per listing (205,181 at N = 1, 900,647 at N = 10),
which is what building a listing costs, so the building is not left out.

Read the units like this (JSON when the output is not a terminal):

```
aiken check -m gero_market/budget -t silent --plain-numbers
```

`-t silent` matters. The default of `aiken check` adds traces to the test program, which makes the
validator look 16% (one listing) to 36% (ten listings) dearer in memory than it is. The deployed
script is built by `aiken build`, which has no traces. Never deploy a build with traces.

**The compiled script.** The tests run `validate` as a plain function. The deployed script wraps it
in code that reads the datum, the redeemer and the script context. To include that wrapper, the
script in `plutus.json` was also run with `aiken uplc eval` on the same transactions (the script
context of each transaction serialised with `cbor.serialise`, the four parameters applied: the fee
address, 100, 1,500,000 and `Some(5,000,000)`), once for every listing of each transaction. This
cross-check is not part of the test suite. It costs 40,000 to 48,000 memory units and 12 to 14
million CPU steps more per run than the tests show. **The compiled-script figures are the ones to
plan with.**

## Results with one royalty per listing

### From the tests (validator without its wrapper)

Per run is the first listing's validator. Per transaction is N times that.

| N | Memory per run | CPU per run | Memory per tx | CPU per tx | % of memory limit | % of CPU limit |
|---|---|---|---|---|---|---|
| 1 | 257,792 | 107,547,942 | 257,792 | 107,547,942 | 1.6% | 1.1% |
| 2 | 358,341 | 146,784,544 | 716,682 | 293,569,088 | 4.3% | 2.9% |
| 5 | 658,788 | 264,302,350 | 3,293,940 | 1,321,511,750 | 20.0% | 13.2% |
| 10 | 1,159,533 | 460,165,360 | 11,595,330 | 4,601,653,600 | 70.3% | 46.0% |
| 11 | 1,259,682 | 499,337,962 | 13,856,502 | 5,492,717,582 | 84.0% | 54.9% |

### From the compiled script (the figures to plan with)

Per run is the first listing's validator. Per transaction is the sum of the runs of all N listings
(a later listing costs more, see below).

| N | Memory per run | CPU per run | Memory per tx | CPU per tx | % of memory limit | % of CPU limit |
|---|---|---|---|---|---|---|
| 1 | 298,562 | 119,908,574 | 298,562 | 119,908,574 | 1.8% | 1.2% |
| 2 | 399,511 | 159,209,176 | 809,452 | 322,891,331 | 4.9% | 3.2% |
| 5 | 702,358 | 277,110,982 | 3,616,090 | 1,430,284,700 | 21.9% | 14.3% |
| 10 | 1,207,103 | 473,613,992 | 12,540,380 | 4,937,423,975 | 76.0% | 49.4% |
| 11 | 1,308,052 | 512,914,594 | 14,962,222 | 5,888,074,379 | 90.7% | 58.9% |

Each listing added to the transaction adds about 101,000 memory units and 39.3 million CPU steps to
every run. The listing that comes later in the transaction costs 10,430 memory units and 4.47
million CPU steps more than the one before it (finding its own input and its outputs walks
further), so the first run is the cheapest and the last the dearest. At N = 10 the last run costs
1,300,973 memory units and 513,870,803 CPU steps.

## The bulk-buy ceiling (phase 3)

**The largest N under 80% of both limits is 10** (one royalty per listing, one wallet UTxO). It was
measured directly, not interpolated: N = 10 uses 76.0% of the memory limit and 49.4% of the CPU
limit, and N = 11, one more, uses 90.7% of the memory limit.

The result does not depend on how the transaction is added up:

| Reading of N = 10 | Memory | % of memory limit |
|---|---|---|
| Compiled script, all ten runs added up | 12,540,380 | 76.0% |
| Compiled script, N times the first run | 12,071,030 | 73.2% |
| Compiled script, N times the last (dearest) run | 13,009,730 | 78.8% |
| Tests, N times the first run | 11,595,330 | 70.3% |
| Tests, N times the last run | 12,534,030 | 76.0% |

Every reading is under 80% at N = 10. At N = 11 every reading is over it, from 84.0% (the tests, N times
the first run) to 94.2% (the compiled script, N times the last run).

The margin is thin, and the ceiling assumes the buyer pays from one wallet UTxO. Each additional
wallet input adds about 11,300 memory units and 6.2 million CPU steps to every run, about 113,000
memory units (0.7% of the limit) per transaction at N = 10. Reference inputs and collateral are not
walked and cost nothing here.

### Three royalties per listing

The datum of every listing in the transaction is decoded by every run, so royalties matter. With
three royalties per listing (the most the wallet lists), each added listing costs about 168,000
memory units and 64.9 million CPU steps per run.

| N | Memory per run | Memory per tx (all runs) | % of memory limit | % of CPU limit | Memory per tx if every run cost as much as the last |
|---|---|---|---|---|---|
| 7 | 1,455,508 | 10,544,842 | 63.9% | 41.1% | 10,901,128 (66.1%) |
| 8 | 1,623,397 | 13,462,224 | 81.6% | 52.5% | 13,937,272 (84.5%) |

The ceiling with three royalties per listing is **7**. N = 8 looks acceptable if only the first run
is multiplied by N (78.7%) and is over 80% once all runs are added up. A transaction that mixes
listings with different numbers of royalties lies between the two ceilings.

## The cost of a single buy (for the builder)

From the compiled script, one listing in the transaction (100 ADA, one wallet UTxO):

| Royalties | Memory | CPU | % of memory limit | % of CPU limit | Execution fee |
|---|---|---|---|---|---|
| 0 | 223,756 | 90,225,409 | 1.4% | 0.9% | 0.019 ADA |
| 1 | 298,562 | 119,908,574 | 1.8% | 1.2% | 0.026 ADA |
| 3 | 448,174 | 179,274,904 | 2.7% | 1.8% | 0.039 ADA |

**Expect about 300,000 memory units and 120 million CPU steps** for a typical purchase. The fee is
the units times the prices read above; a ten-listing transaction costs about 1.08 ADA in execution
fees. The tests alone give lower numbers (257,792 and 107,547,942 with one royalty) because they
leave out the wrapper.

## Why the cost is quadratic

The combined fee check (spec 5.4 rule 3) lets one fee output pay for every listing in the
transaction. To know what the fee output must hold, the validator of each listing decodes the
datum of every input at the contract's script hash and adds up their fees, then compares the sum
with what the transaction pays to the fee address. With N listings there are N validator runs and
each walks N inputs, so the work is proportional to N times N. That is why a run at N = 10 costs
four times a run at N = 1 while the transaction costs about 42 times as much. Nothing else in the
validator depends on N.

## What these figures do not include

- **The node's cost model.** Aiken v1.1.24 evaluates with its own built-in Plutus V3 cost model.
  The node may use slightly different values. The builder must evaluate every transaction with the
  node's parameters before it submits it and must not rely on these tables for the budget it sets.
- **Script size and transaction size.** The validator is about 1.9 KB. Spending it from a reference
  script is charged by the byte, not in execution units. Each listing also adds an input, a
  redeemer and several outputs to a transaction that is limited to 16,384 bytes. Neither is
  measured here.
- **Datum shapes other than the tests'.** The tests use a base-address seller and base-address
  royalty payees. Other address forms, longer datums and more royalties change the decoding cost.
- **Changes to the validator.** Any change to `spend.ak`, `rules.ak` or `fee.ak` changes these
  numbers. Run the tests again after one.
