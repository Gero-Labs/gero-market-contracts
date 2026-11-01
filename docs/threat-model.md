# Threat model of the Gero listing contract

This page lists what can go wrong around a listing, what in the contract (or outside it) stops it,
and what is left to the wallet. It is written for auditors and for the people who run the
deployment. The rules themselves are in [rules.md](rules.md), and every threat below has an
identifier (T1 to T16) that [test-inventory.md](test-inventory.md) maps to tests.

## What is protected, and from whom

| Asset | Who could take it wrongly |
|---|---|
| The listed NFT and its deposit | Anyone but the owner, except through a purchase that pays the seller in full |
| The seller's proceeds and the deposit | A buyer who underpays, or who makes one output count twice |
| Creator royalties | A buyer who skips or underpays them |
| The fee owed to A.D. Labs | A buyer (or a seller) who skips, shares or redirects it |

The contract has no administrator. Nobody, A.D. Labs included, can move a listing except its owner
(by `Cancel`) or a buyer who pays everyone what the datum names. The A.D. Labs keys behind the fee
address have no power over a listing: that address only **receives** funds, and losing its keys
loses fee revenue and never user funds.

What the contract can see is the transaction that spends a listing. It cannot see how a listing was
created, who built the transaction, or which front end the user used. Those risks are in the second
half of this page.

## Threats and mitigations

"Layer" says where the mitigation lives: **Contract** (enforced on chain by the validator),
**Deployment** (enforced by how a version is built and published), **Wallet** (enforced off chain by
Gero Wallet; the contract cannot help) or **Chain** (a property of the ledger).

| Id | Threat | Layer | Mitigation |
|---|---|---|---|
| T1 | Double satisfaction: two listings bought together share one seller or royalty output | Contract | Those outputs must carry the listing's own tag (a hash of its output reference), so one output counts for one listing only |
| T2 | Several listings share one fee | Contract | The outputs at the fee address must hold the **sum** of the fees of every listing of this script in the transaction |
| T3 | A transaction spending listings of two contract versions, or of two contracts that charge a fee, pays one fee for both | Deployment | A fee address is used by exactly one version of exactly one contract, so the sum of one cannot cover another. Versions are kept apart by the version number in the fee script. Contracts are not yet: the fee address is derived from the three signers and the version number alone, so a second fee-charging contract derived with the same signers and number would get the same address, and one output could pay both contracts' fees. Before a second fee-charging contract exists, its fee address needs a per-contract discriminator (see [deploying.md](deploying.md#rules-that-never-bend)) |
| T4 | The fee is skipped or redirected | Contract, Deployment | The fee address and the amount come from the compiled parameters and the datum price, compared as the full address. There is no waiver key and no fee field in the datum |
| T5 | A buyer (A.D. Labs included) overpays the fee to underpay the seller | Contract | The seller's due is computed from the datum and the parameters, never from the amounts actually paid |
| T6 | A listing advertises a lower price than buyers pay (negative royalty entries) | Contract | Every royalty must be greater than zero, so the seller's due can never exceed `price - fee + deposit` |
| T7 | A fee below the minimum ADA of an output bricks small sales | Contract, Wallet | `min_fee` is 1.5 ADA, above the roughly 1 ADA a fee output needs; the wallet refuses list prices under `MIN_LIST_PRICE` |
| T8 | A bad datum at listing time (proceeds to someone else, wrong owner, wrong price) | Wallet | The wallet checks the datum against the user's intent before signing (see [rules.md](rules.md#what-the-contract-cannot-enforce)). The contract cannot protect this step |
| T9 | A fake "your listing": an attacker locks junk at the script with the victim's stake key and `owner` set to the victim | Wallet | A listing is shown as the user's only if `owner` is one of its own keys **and** `seller_address` is one of its own addresses. Anything else is hidden |
| T10 | Token dust in a listing | Contract, Wallet | The seller and royalty outputs the contract requires are ADA only. The contract does not restrict what a listing UTxO holds, so the wallet shows its full value |
| T11 | Counterfeit collections | Wallet | The wallet shows the policy id, uses a verified-collection flag, warns on lookalike names and reads royalties only from the policy's own token |
| T12 | A UTxO sent to the script address with no datum, or with a datum that is not a `Listing` | Contract, Wallet | Nothing on chain can stop the send. None of these can be bought: a `Purchase` needs a complete inline `Listing`. Whether a `Cancel` works depends on the datum ([D1](rules.md#how-the-validator-is-entered), [F6](#f6-a-datum-that-is-a-constructor-but-not-a-listing)). With a constructor of the wrong shape, the key in its field 0 can cancel it. With no datum, or a datum that is not a constructor (an integer, a list), nobody can move it and the NFT and ADA are lost for good. The wallet never creates any of these and warns that manual sends can be unrecoverable |
| T13 | Two buyers race for one listing | Chain, Wallet | The loser's transaction fails the ledger's first validation phase (input already spent) and loses no collateral. The wallet evaluates the scripts before submitting, so a transaction cannot fail the script phase and cost its collateral |
| T14 | A malicious dApp spends the user's listing | Contract, Wallet | `Cancel` needs the owner's signature. The wallet's signing preview must show listing inputs owned by the wallet as outgoing assets |
| T15 | The remote transaction builder is compromised and builds a buy with wrong outputs | Wallet, Contract | The wallet checks the fee, seller and royalty outputs against the indexed datum and the parameters, and the buyer's net outflow. A wrong output also fails the script, which costs the collateral if the transaction is submitted without being evaluated first |
| T16 | The script is reused for another purpose (minting, withdrawing, certificates, voting, proposing) | Contract | The `else` handler fails |

## Behaviours the review should look at

These are deliberate. Each names the tests that pin it (or, for the budget, measure it), so an
auditor can see it is not an accident.

### F1. A listing with a datum hash

A listing UTxO that carries a datum hash instead of an inline datum **can be cancelled by its owner
and can never be purchased**. The ledger resolves a datum hash from the witness set and gives the
validator the datum value, so the first check of the validator (`Some(listing)`) passes and the
owner's `Cancel` works. A `Purchase` fails, because the combined fee of
[rule P3](rules.md#p3-the-combined-fee) decodes the datum of **every** input at the script from its
inline datum, and a hash is not one. The same failure blocks any purchase in a transaction that
carries such an input, even when the input is not the one being bought.

Tests: `purchase_hash_datum_listing_fails` (the hash-datum listing is the one bought),
`purchase_next_to_a_cancelled_hash_datum_listing_fails` (an inline listing bought while a
hash-datum listing of the same script is cancelled in the same transaction; its control
`purchase_next_to_a_cancelled_inline_listing_passes` is the same transaction with that listing
inline), `total_fees_hash_datum_fails` (the fee total itself) and `cancel_hash_datum_listing_passes`
(the owner can take it back).

**This is a fail-closed behaviour that rests on one place.** No other line of the purchase path
looks at the datum form of the other inputs. The `fee-covered` clause must therefore keep calling
the fee total over all inputs at the script's own hash; narrowing it to the spent input would let a
hash-datum listing, or a transaction that carries one, be bought. The mutation check pins this: the
test `purchase_hash_datum_listing_fails` is among those that kill the `fee-covered` mutant (see the
[test inventory](test-inventory.md)).

### F2. The fee address named as a royalty payee or as the seller

The combined fee sums **every** output at the fee address, whatever else the output is for. So a
tagged royalty output paid to the fee address counts toward the fee, and so does a seller output
when `seller_address` is the fee address (A.D. Labs selling an NFT of its own). A.D. Labs still
receives at least the fee, but not necessarily the fee plus the royalty: for a 100 ADA listing with
a 2 ADA royalty to the fee address, the fee address receives 2 ADA and the 1.5 ADA fee is already
covered by it. A royalty smaller than the fee does not cover it (a 1.2 ADA royalty to the fee
address with no other fee output is rejected). This follows from the royalty and the fee being one
payment to one address.

Tests: `fee_address_as_royalty_payee_counts_toward_fee`, `fee_address_as_royalty_payee_below_the_fee_fails`,
`fee_address_as_seller_counts_toward_fee`.

### F3. The bulk-buy budget ceiling

Buying N listings in one transaction runs N validators that each walk N inputs, so the cost grows
with the square of N. [budget.md](budget.md) measures it. With the version 1 terms and one wallet
UTxO paying, **10 listings** with at most one royalty each, or **7** with three royalties each, stay
under 80% of the transaction memory and CPU limits **according to Aiken's cost model**. Treat these
as upper bounds: the node may price operations differently, the transaction size limit is not
measured, and outputs beyond the modelled shape add cost. A builder must evaluate every transaction
with the node's own parameters before submitting it. A transaction that needs more than the limit
cannot be built, and one submitted with a budget that is too small fails the script phase and costs
the collateral. A single purchase is not affected by other people's listings: only the inputs a
transaction spends are walked.

Measured by: `budget_purchase_n_*` and `budget_baseline_n_*` in `budget.test.ak` (each purchase
test also asserts the purchase passes), and `scripts/eval-applied.mjs`, which runs the applied
preprod version 1 script on a single buy with no, one and three royalties
(`scripts/eval-applied.test.mjs` asserts the units).

### F4. The tag encoding

The tag is the hash of the output reference's CBOR as Plutus writes it: an **indefinite-length**
constructor, with the index in the shortest unsigned-integer form. Off-chain code that builds the
bytes with a one-byte index, or with a definite-length array, makes every purchase of such a listing
fail. The vectors for indices 0, 23, 24 and 256 are in `test-vectors/tags.json` and are checked by
Aiken tests and by a separate JavaScript implementation.

Tests: `serialise_index_0`, `serialise_index_23`, `serialise_index_24`, `serialise_index_256`,
`tag_index_0`, `tag_index_23`, `tag_index_24`, `tag_index_256`, and `scripts/check-vectors.mjs`
(tested by `scripts/check-vectors.test.mjs`), which rebuilds the bytes without Aiken.

### F5. Parameter encoding mistakes

A parameter with a valid shape but a wrong value (a bare integer for `max_fee`, a stake part
encoded as a pointer, a key hash where a script hash goes) produces a valid script with another
hash, and a script nobody meant to deploy. Each deployment applies the parameters with two
independent implementations (the Aiken CLI, and Lucid Evolution) and requires the same script hash
before anything is published. See [deploying.md](deploying.md).

Tests: `catches the parameter encoding mistakes that still give a valid script` in
`scripts/verify-params.test.mjs`, with the encoding tests of `scripts/apply-params.test.mjs`. CI runs
`scripts/verify-deployments.mjs`, which repeats the comparison for every committed deployment.

Two implementations cannot catch a mistake in the source itself, because both apply the parameters
to the same compiled code. A wrapper that passed its parameters on in the wrong order (`fee_bps`
and `min_fee` swapped, which would charge 5 ADA on every sale) gives the same hash in both. That is
caught by `validators/listing.test.ak`, which calls the validator's handler with the version 1 terms
(the swap fails `spend_purchase_pays_everyone`, `spend_purchase_at_300_ada_pays_one_percent` and
four more), and by `scripts/eval-applied.mjs`, which runs each deployment's applied script and
expects a 100 ADA purchase with a 1.5 ADA fee to pass.

### F6. A datum that is a constructor but not a `Listing`

The compiled script reads the datum field by field, only as far as a rule needs. A `Cancel` reads
the owner, field 0, and nothing else. So a signed `Cancel` succeeds for **any constructor datum
whose field 0 is the signer's key hash**, however wrong the rest is: a sixth field, another
constructor index, a price that is bytes, a buyer that is an integer, a `seller_address` that is
not an address, or no field but the owner. It costs the same as the cancel of a real listing, and
the same cancel without the signature fails. A `Purchase` of such a UTxO always fails, because the
fee total expects every input at the script to carry an inline datum that is a complete `Listing`;
so does any purchase in a transaction that carries one. Out of reach of `Cancel` are only a UTxO
with no datum and one whose datum has no readable owner: not a constructor (an integer, a list,
bytes, a map), or a constructor whose field 0 is missing or not a byte string. Nothing can move
those, and they are lost for good.

So today a malformed datum is never purchasable, and only the key in its field 0 can move it. The
wallet must never create one (T8, T12).

**Open question for the audit:** whether the contract should reject malformed datums strictly,
on `Cancel` as well as on `Purchase`, instead of reading only the owner. The deployed script
does not; its behaviour is pinned here so that the answer is a deliberate change and not a
surprise.

Tests: on the applied script only, because Aiken's typed tests cannot build an ill-typed datum.
`scripts/eval-applied.mjs` runs `cancel_constr_datum` (a `Listing` with a sixth field, signed by
its owner: passes, at exactly the units of `cancel_ok`), `cancel_constr_datum_unsigned` (fails),
`purchase_constr_datum` (the purchase of `purchase_ok` with that datum: fails), and
`cancel_bad_datum` (the integer 42, signed by the owner: fails) and `cancel_no_datum` (fails). The
other wrong shapes named above were tried by hand on the preprod version 1 script, not in CI.

## What the contract does not do

These are accepted limits, not oversights.

- **It does not validate listings when they are created.** See T8 and [rules.md](rules.md).
- **It does not check its own parameters.** The deployment tools and the review do.
- **It does not limit the royalty list.** The wallet allows three entries. A very long list makes a
  listing unbuyable (too large for one transaction) and leaves it cancellable.
- **It does not check where the NFT goes** on a purchase, nor the reference-script field of the
  seller and royalty outputs.
- **It does not stop the owner from cancelling** at any time, including in the same block as a buy.
  The buyer's transaction then fails the first validation phase (T13).
- **It cannot be paused, upgraded or patched.** A fix is a new script hash, a new fee address and a
  new deployment. The wallet keeps the old deployment in its list until its listings drain, so
  owners can still cancel and buyers can still buy them.
- **The datum is read by Aiken's generated wrapper field by field, as the rules ask for it.** It is
  not checked as a whole before they run (see F6). The tests in `lib/` call the rules directly.
  `validators/listing.test.ak` calls the validator's handler with its four parameters, and
  `scripts/eval-applied.mjs` runs the compiled script of each deployment, its parameters applied, on
  committed script contexts: purchases that pay and one that does not, cancels, a UTxO with no datum,
  one whose datum is the integer 42 (both refused), and one whose datum is a `Listing` with a sixth
  field (its owner can cancel it, nobody can buy it). No test presents a malformed redeemer, or a
  script context of another shape, to the compiled script.

## Off-chain rules the contract cannot enforce

The validator runs only when a listing is spent, so these checks live in the wallet. The full list
is in [rules.md](rules.md#what-the-contract-cannot-enforce). In short, before it asks for a
signature on a list or a reprice, the wallet verifies:

| What is checked | Risk if it is not |
|---|---|
| The output address is the Gero listing script (a hash on the reviewed list) with the wallet's own stake credential | The NFT is sent to a look-alike script |
| The value is exactly the chosen NFT (the `(222)` user token for CIP-68), quantity 1, plus the deposit | Other assets are locked, or the reference token is sold |
| The datum is inline and decodes as `Listing` | The listing cannot be bought, or is read wrongly |
| `owner` is the key the wallet will sign with and `seller_address` is one of its own addresses | The proceeds go to someone else, or the owner cannot cancel |
| `price` and `buyer` are what the user chose | The NFT is sold at the wrong price or to the wrong person |
| `royalties` are exactly as computed from the collection's own policy, capped at 10% unless the seller confirms, at most three, none below the minimum ADA of an output | The seller pays royalties the collection does not ask for, or a sale is bricked |
| The seller share is at least `MIN_SELLER_SHARE`, and the price is at least `MIN_LIST_PRICE` | Sales that cannot be built |

On the buying side the wallet checks the fee, seller and royalty outputs against the datum and the
parameters, shows the buyer's net cost, and evaluates the scripts before it submits (T13, T15).

## Trust assumptions

- **The compiler and the ledger.** The validator is compiled by Aiken v1.1.24 with the standard
  library v4.0.0 and runs under Plutus V3. A bug in either is outside this model.
- **The published parameters.** The deployed script hash must equal the hash of the committed source
  with the parameters of its deployment folder. Anyone can recompute it.
- **The fee address keys.** Two of three A.D. Labs keys are needed to spend from the fee address. They
  never touch a listing.
- **The reference script lock.** The reference script is published at an address no transaction can
  spend from, so it stays where wallets find it. It holds no authority over a listing.
