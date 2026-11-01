# Rules of the Gero listing contract

This page is the public specification of the Gero listing contract. The validator in
`validators/listing.ak` and `lib/gero_market/` is written from it. Each rule has an identifier
(D1, P1 to P7, C1, E1, G1) that [test-inventory.md](test-inventory.md) maps to the tests and
mutation checks that pin it. If this page and the code ever disagree, the code is what runs on
chain: please report the difference.

Related pages: [threat-model.md](threat-model.md) (what the rules protect against, and what they
cannot), [budget.md](budget.md) (execution cost), [deploying.md](deploying.md) (how a version goes
live).

## What the contract does

A listing is an NFT locked at the address of one Plutus V3 spending validator, `listing`, together
with a small ADA deposit and an inline datum (a `Listing`) that says who owns it, who gets paid and
how much. A listing can leave the script in exactly two ways: its owner cancels it, or someone buys
it by paying everyone the datum names. There is no administrator, no fee waiver and no upgrade
path.

The validator runs only when a listing is **spent**. Nothing checks a listing when it is
**created**, so a bad datum is accepted on chain and only shows when the listing is spent. See
[What the contract cannot enforce](#what-the-contract-cannot-enforce).

## Parameters

Four values are applied to the validator when it is compiled, in this order. Each one changes the
script hash. None of them appears in the datum, and there is no key that waives the fee.

| Parameter | Type | Meaning |
|---|---|---|
| `fee_address` | `Address` | The fee address, compared as a **full address** (payment and stake parts) |
| `fee_bps` | `Int` | Fee in basis points of the price |
| `min_fee` | `Int` | Minimum fee in lovelace |
| `max_fee` | `Option<Int>` | Optional cap in lovelace |

**Version 1 values:** `fee_bps = 100` (1%), `min_fee = 1_500_000` (1.5 ADA),
`max_fee = Some(5_000_000)` (5 ADA), and a fee address of the form described in
[deploying.md](deploying.md). Each version has its own fee address.

The contract does not check its own parameters. The deployment tools and review do:
`0 < fee_bps < 10000` and at most `1000`, `min_fee >= 0`, `max_fee` absent or at least `min_fee`,
and a fee address that is a base address with a script payment part and a key stake part. A bad
parameter set is a bad script hash, and a bad script hash is never put into the wallet.

## Types

```aiken
pub type Payee {
  address: Address,
  lovelace: Int,
}

pub type Listing {
  /// Seller's payment key hash. Must sign Cancel.
  owner: VerificationKeyHash,
  /// Where the seller's proceeds (and the deposit) go.
  seller_address: Address,
  /// What the buyer pays to payees, in lovelace (fee + royalties + seller share).
  price: Int,
  /// Creator royalties. May be empty.
  royalties: List<Payee>,
  /// Private sale: only this key may buy. None = public listing.
  buyer: Option<VerificationKeyHash>,
}

pub type Action {
  /// `first_output` is the index of this listing's seller output; its royalty
  /// outputs follow it in order. The fee is paid separately (combined fee output).
  Purchase { first_output: Int }
  /// Owner removes the listing; also used to reprice (cancel and relist in one tx).
  Cancel
}
```

As Plutus data (the full schema is in the `definitions` of `plutus.json`):

| Type | Plutus data |
|---|---|
| `Listing` | constructor 0 with the fields `owner`, `seller_address`, `price`, `royalties`, `buyer`, in this order |
| `Payee` | constructor 0 with `address`, `lovelace` |
| `Purchase { first_output }` | constructor 0 with one field, the integer |
| `Cancel` | constructor 1 with no fields |
| `Option` | `Some(x)` is constructor 0 with one field, `None` is constructor 1 with none |
| `Address` | constructor 0 with a payment credential and an optional stake credential. A key credential is constructor 0 with a hash, a script credential is constructor 1 with a hash. A stake credential is `Inline(credential)`, constructor 0; a pointer is constructor 1 and is a different address. |

## How the validator is entered

- **D1, the datum must be a `Listing`.** The validator requires a datum (`Some(listing)`). Past
  that, the compiled script reads the datum **field by field, only as far as a rule needs**: a
  `Cancel` reads one field, the owner (field 0), and a `Purchase` checks, through the fee total
  ([P3](#p3-the-combined-fee)), that every input at the script is a complete inline `Listing`.
  So a UTxO at the script address that is not a well-formed listing behaves like this:
  - **A constructor datum of the wrong shape** (for example a `Listing` with a sixth field, another
    constructor index, a price that is bytes, a buyer that is an integer, or only the owner field):
    `Purchase` always fails, and `Cancel` succeeds when the key in field 0 signs. It can never be
    bought, and whoever holds that key can take the NFT and the ADA back.
  - **A datum with no readable owner:** not a constructor at all (the integer 42, a list), or a
    constructor whose field 0 is missing or not a byte string. `Cancel` cannot read an owner and
    fails too. Nothing can move the UTxO.
  - **No datum:** the `Some` check fails for both actions. Nothing can move the UTxO.

  The last two are locked for good, NFT and ADA alike. Nothing on chain can stop someone sending
  any of these to the script address. The wallet must never create one, and nobody should send to
  the script address by hand. (A listing whose datum is a hash of a valid `Listing` is a different
  case: see [Behaviours worth knowing](#behaviours-worth-knowing).) Whether the contract should
  instead reject every malformed datum on `Cancel` too is an open question for the audit: see
  [F6 of the threat model](threat-model.md#f6-a-datum-that-is-a-constructor-but-not-a-listing).
- **E1, nothing but spending.** Any other purpose (minting, withdrawing, certificates, voting,
  proposing) reaches the `else` handler, which fails. The script cannot be used for anything but
  holding listings.

## Purchase

A purchase spends one listing with `Purchase { first_output }`. These quantities are used below.
"The listing" is the UTxO being spent and `l` is its datum.

```
fee        = listing_fee(l.price)                  rule P1
deposit    = all the lovelace held by the listing UTxO
share      = l.price - fee - (the sum of the lovelace of l.royalties)
seller_due = share + deposit
```

The deposit is the whole lovelace of the listing UTxO as it was spent, read from the input at the
listing's own output reference, wherever that input sits among the transaction's inputs. It is paid
out of that input, so it is the seller's own ADA coming back and costs the buyer nothing.

The transaction is accepted when P2, P3, P5 and P6 all hold, with each payment checked as P4 says.
P1 defines the fee and P7 is a non-rule.

### P1. The fee

```
listing_fee(price) = clamp(min_fee, max_fee, floor(price * fee_bps / 10000))
```

The minimum is applied first and the cap last: take the larger of the proportional fee and
`min_fee`, then the smaller of that and `max_fee` when there is a cap. The division rounds down.
With no cap, only the minimum applies. A cap below the minimum (which the deployment review
refuses) would win.

### P2. The seller's share is positive

`share > 0`. A listing whose fee and royalties leave nothing for the seller can never be bought. Its
owner can still cancel it.

Example with the version 1 terms: a 3.5 ADA listing with one 2 ADA royalty has a 1.5 ADA fee, so the
share is `3.5 - 1.5 - 2 = 0` and it cannot be bought. At 3.500001 ADA the share is 1 lovelace and it
can.

### P3. The combined fee

```
fee_paid = the lovelace of every output whose address equals fee_address
fee_due  = the sum of listing_fee(price) over every input of the transaction
           that is at this script's own hash, whatever its redeemer
fee_paid >= fee_due
```

In detail:

- An output counts toward `fee_paid` only if its address equals `fee_address` exactly, payment and
  stake part both. The same script with another stake key does not count. The outputs may be one or
  several, anywhere in the output list, with or without a datum.
- The script hash used to select the inputs is the hash of the listing being spent, taken from the
  spent output itself, not from a parameter. Every input whose payment credential is that script
  counts, whatever its stake credential and **whatever redeemer it is spent with**: a listing
  cancelled in the same transaction adds its fee to the total, exactly like one bought. The wallet
  never mixes the two, so nobody overpays in practice. Inputs at other scripts, key addresses and
  reference inputs are not counted.
- Every counted input must carry an **inline** datum that decodes as a `Listing`. An input at the
  script with a datum hash, no datum or any other datum makes the whole purchase fail, even when
  that input is not the one being bought. This is what makes a listing with a datum hash impossible
  to buy (see [Behaviours worth knowing](#behaviours-worth-knowing)).
- Each listing's validator recomputes the same total, so with N listings bought together the
  transaction runs N validators that each walk N inputs. The cost grows with the square of N: see
  [budget.md](budget.md).
- The sum covers only listings of the same script. A transaction that spent listings of two
  contract versions, or of two contracts that both charge a fee, could pay one fee for both if
  they shared a fee address. That is why a fee address belongs to exactly one version of exactly
  one contract (see T3 in [threat-model.md](threat-model.md)).

Why the fee is summed and not tagged: the fee goes to one address for every listing, so requiring
the outputs at that address to hold the sum of all the fees is enough to stop one fee being counted
twice. One untagged fee output needs only about 1 ADA of minimum ADA, against about 1.2 ADA for a
tagged one, and a bulk buy pays one fee output instead of one per NFT.

### P4. A payment to a payee

The seller output and every royalty output must each be a payment `pays(out, address, amount, tag)`
that holds all of the following:

- `out.address == address`, the full address, payment and stake part;
- the value is **ADA only**;
- `lovelace >= amount` (paying more is accepted);
- `out.datum` is the inline datum equal to `tag` (a datum hash or no datum fails).

The seller output is checked with `address = l.seller_address` and `amount = seller_due`. The
contract does not look at the output's reference-script field.

The `tag` is specific to the listing (see [G1](#g1-the-tag)). Without it, two listings bought in one
transaction by the same seller, or with the same royalty payee, could be paid by one shared output:
one output would satisfy both validators. A tagged output counts for only one listing, so no order
between listings has to be enforced.

### P5. Where the outputs are

The transaction's outputs, counted from index `first_output`, are:

1. the seller output (`seller_due`, which includes the deposit, so the deposit goes back to the
   seller);
2. one output per entry of `l.royalties`, in datum order, each paying that entry's address at least
   its amount.

Details:

- The fee output(s) of P3 may be anywhere; they need not be next to the group.
- Outputs after the last royalty are ignored.
- Every royalty entry must have `lovelace > 0`. Otherwise a negative entry would raise the seller's
  due above what the price advertises (a 100 ADA listing with a 1.5 ADA fee, a royalty of -1 ADA and
  a 2 ADA deposit would owe the seller 101.5 ADA), and buyers using another interface would pay
  more than the listed price. With every royalty positive, `seller_due` can never exceed
  `price - fee + deposit`.
- If `first_output` is past the last output there is no seller output and the purchase fails. A
  negative `first_output` is read as 0.
- The seller's amount is computed from the datum and the parameters, never from the amounts the
  transaction actually pays. If it were `price - fee paid`, a buyer, A.D. Labs included, could
  overpay the fee output and underpay the seller. Computing it from the datum removes that conflict
  of interest.

### P6. Private sale

If `l.buyer` is `Some(k)`, then `k` must be among the transaction's required signers
(`extra_signatories`). A key that signs without being listed as a required signer does not count. If
`l.buyer` is `None` anyone may buy.

### P7. Where the NFT goes is not checked

The buyer chooses where the NFT, and any other asset in the listing UTxO, ends up. The contract
requires only that the payees above are paid.

## C1. Cancel

`Cancel` needs the owner's key hash (`l.owner`) among the required signers, and nothing else. There
are no output rules, so the same transaction can send the NFT anywhere or list it again at a new
price (a reprice). Being the designated `buyer` of a private listing gives no right to cancel it.
Of the datum it reads only `owner`, so a datum of the wrong shape does not stop it (see D1).

## G1. The tag

```
tag = blake2b_256(cbor.serialise(own_ref))
```

`own_ref` is the output reference of the listing being spent. Plutus serialises it as an
indefinite-length constructor, and off-chain code must build exactly these bytes:

```
d8799f 5820 <32-byte transaction id> <index as a CBOR unsigned integer> ff
```

The index uses the shortest CBOR form: one byte for 0 to 23, then `18 nn` up to 255, `19 nnnn` up to
65535 and `1a nnnnnnnn` beyond that. A builder that uses a fixed one-byte index, or a
definite-length array (`d87982 ...`), produces a different hash, and every purchase of a listing
with such a reference fails. `test-vectors/tags.json` pins the bytes and the tag for indices 0, 23,
24 and 256, and `scripts/check-vectors.mjs` rebuilds them without Aiken. The tag is carried as an
inline datum holding that 32-byte string.

## Fee examples

Version 1 terms (1%, minimum 1.5 ADA, cap 5 ADA), no royalty. "Share" is `price - fee`, before the
deposit is added.

| Price | Fee | Share | Why |
|---|---|---|---|
| 10 ADA | 1.5 ADA | 8.5 ADA | the minimum |
| 100 ADA | 1.5 ADA | 98.5 ADA | the minimum |
| 150 ADA | 1.5 ADA | 148.5 ADA | 1% is exactly the minimum |
| 150.000099 ADA | 1.5 ADA | 148.500099 ADA | 1% is 1,500,000.99 lovelace, rounded down |
| 151 ADA | 1.51 ADA | 149.49 ADA | 1% |
| 499.99 ADA | 4.9999 ADA | 494.9901 ADA | 1% |
| 500 ADA | 5 ADA | 495 ADA | 1% is exactly the cap |
| 5,000 ADA | 5 ADA | 4,995 ADA | the cap |

The minimum applies below 150 ADA and the cap from 500 ADA.

### One purchase, with numbers

A 100 ADA listing locked with a 2 ADA deposit, owing the creator a 2 ADA royalty. The fee is 1.5 ADA
(the minimum), the share is `100 - 1.5 - 2 = 96.5` ADA and `seller_due = 96.5 + 2 = 98.5` ADA. The
transaction pays:

| Output | Amount | Address | Datum |
|---|---|---|---|
| fee output | 1.5 ADA | the fee address | none needed |
| seller output (at `first_output`) | 98.5 ADA | `seller_address` | the tag |
| royalty output (next) | 2 ADA | the creator | the tag |

The payees receive `1.5 + 98.5 + 2 = 102` ADA, but 2 ADA of that is the deposit, which comes out of
the listing input. The buyer's net outflow is therefore the price, 100 ADA, plus the transaction fee.
The buyer also funds the minimum ADA of the output that receives the NFT, and that ADA stays theirs.

### Two purchases in one transaction

Add a second listing of 600 ADA with no royalty and a 3 ADA deposit. Its fee is 5 ADA (the cap) and
its seller is due `600 - 5 + 3 = 598` ADA. One fee output of at least `1.5 + 5 = 6.5` ADA pays for
both. A fee output of 1.5 ADA or of 5 ADA alone, or of 6.499999 ADA, is rejected by both validators.

### Minimum ADA of the outputs

The ledger requires every output to hold a minimum of ADA. At the protocol parameters of epoch 665
(4,310 lovelace per byte) the fee output needs about 0.97 ADA, and a seller or royalty output with
its 32-byte inline datum about 1.16 ADA. The contract accepts more than the amount it asks for, so
a builder may raise an output to its minimum. Where it does, the buyer pays the difference. `min_fee`
is 1.5 ADA so that a fee output is never below its minimum.

## Behaviours worth knowing

These follow from the rules above. [test-inventory.md](test-inventory.md) names the tests behind
each of them that can be tested.

- **The combined fee counts every input at the script's own hash**, whatever its redeemer or stake
  part. A cancel and a purchase in one transaction pay both fees.
- **A listing with a datum hash can be cancelled and never bought.** The ledger resolves a datum hash
  from the transaction's witness set and hands the validator the datum value, so the owner's
  `Cancel` works when the datum is supplied. A `Purchase` fails because the fee total expects every
  input at the script to carry an inline datum.
- **A datum of the wrong shape can be cancelled and never bought.** `Cancel` reads only the owner
  (field 0) from the datum, so a constructor datum that is not a complete `Listing` but has the
  owner's key hash first can be cancelled by that key. A `Purchase` fails. See D1 above.
- **A negative `first_output` behaves as 0.** It cannot help a buyer: whichever outputs it selects
  must still pay the seller and the royalties in full, tagged for this listing.
- **Outputs after the last royalty are ignored.** The NFT delivery and the buyer's change usually
  follow there.
- **Where the NFT goes is not checked.**
- **The fee address may also be a payee.** If the fee address is a royalty payee or the seller
  address, that output counts toward `fee_paid` as well. The fee address then receives at least the
  fee, not necessarily the fee plus the royalty.
- **The deposit and the tag come from the listing's own output reference**, not from the first
  input or the first listing, so a buyer's UTxO ahead of the listing, or a dearer listing ahead of
  it, changes nothing.
- **Datum limits are not on chain.** The contract does not limit the number of royalties; the wallet
  does (three). A listing with a very long royalty list is not buyable in practice because the
  transaction would be too large, and its owner can still cancel it.

## What the contract cannot enforce

The validator runs only when a listing is spent. Before it signs a list or a reprice, the wallet
must check all of the following against what the user chose. A front end that skips them can create
a listing the contract cannot protect, and the seller's NFT can then be lost at the first sale.

**The listing UTxO**

- The output address is the Gero listing script (a hash on the wallet's reviewed list of
  deployments) with the wallet's own stake credential.
- The value is exactly the chosen NFT, quantity 1, plus the deposit. No other assets. For CIP-68
  NFTs this is the `(222)` user token, never the `(100)` reference token.
- The datum is inline and decodes as a `Listing` with:
  - `owner` the payment key hash the wallet will sign with;
  - `seller_address` one of the wallet's own addresses;
  - `price` the price the user entered;
  - `royalties` exactly as computed below;
  - `buyer` as the user chose.

**Limits the wallet applies** (wallet constants, not contract parameters)

- `price - fee - (sum of royalties)` is at least `MIN_SELLER_SHARE`, which is at least the minimum
  ADA of an output.
- At most `MAX_ROYALTIES` = 3 royalty entries.
- A list price under `MIN_LIST_PRICE` (planned at 5 ADA) is refused, so that small sales are not
  bricked by minimum-ADA effects.

**Royalties**

- Read from CIP-27 (metadata label 777, honouring `rate` and the legacy `pct`) or CIP-102 (the
  `(500)Royalty` reference datum), and only from the collection's own policy.
- The rate is capped at `ROYALTY_RATE_CAP` = 10%. Anything above needs the seller's explicit
  confirmation.
- A royalty amount below the minimum ADA of an output is left out of the datum, and the list sheet
  tells the seller.

**When buying**, the wallet checks the fee, seller and royalty outputs of a transaction built by a
remote service against the indexed datum and the parameters, shows the buyer's net cost, and
evaluates the scripts before submitting, so that a transaction cannot fail the script phase and cost
the collateral.

## How the transactions look

| Action | Inputs | Outputs | Scripts run | Signers |
|---|---|---|---|---|
| List | Seller UTxOs holding the NFT | The listing (script address with the seller's stake credential, NFT and deposit, inline `Listing`), change | None | Seller payment key |
| Reprice | The listing (`Cancel`) | A new listing at the new price, change | Listing contract | Owner |
| Cancel | The listing (`Cancel`) | NFT and deposit back to the seller | Listing contract | Owner |
| Buy | The listing (`Purchase { first_output }`), buyer UTxOs | One fee output; `[seller, royalties...]` from `first_output`, each tagged; NFT to the buyer; change | Listing contract | Buyer, plus the `buyer` key if set |
| Bulk buy | N listings | One fee output holding the sum of N fees; N tagged groups, each with its own `first_output` | Listing contract, N times | Buyer |

Every script spend references the deployed reference script, requires collateral, and puts the
keys the validator checks in the transaction's required signers.
