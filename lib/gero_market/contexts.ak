//// Script contexts for running a deployed (applied) script, built from the deployment's own values.
////
//// A normal library module (not a `.test.ak` file), like `fixtures`, so that the tests of
//// `validators/` and of `lib/` can both use it. Nothing in the validator depends on it.
////
//// `scripts/eval-applied.mjs` evaluates the compiled, applied script of each deployment
//// (`deployments/<network>-v<N>/script.json`) on the script contexts in
//// `test-vectors/contexts/<network>-v<N>/`. Those files are `cbor.serialise` of the contexts built
//// here, and `contexts.test.ak` pins each one byte for byte, so the files and this module cannot
//// drift apart. A context belongs to one deployment: its listing input sits at that deployment's
//// script hash and its fee output pays that deployment's fee address. The amounts are those of the
//// version 1 terms (1%, minimum 1.5 ADA, cap 5 ADA): a deployment with other terms needs contexts
//// of its own.
////
//// The purchases are the single buy that `docs/budget.md` measures: the buyer's wallet UTxO first,
//// then the listing; one fee output, the seller output, the royalty outputs, the buyer's change and
//// the output that delivers the NFT.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{
  Address, Inline, Script, VerificationKey, from_verification_key,
}
use cardano/assets.{from_asset, from_lovelace, merge}
use cardano/script_context.{ScriptContext, Spending}
use cardano/transaction.{
  Datum, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use gero_market/fixtures.{
  ada_out, buyer_key, creator_key, listing, nft_name, nft_policy,
  other_stake_key, out_ref, seller, seller_key, seller_stake_key, tagged_out, tx,
}
use gero_market/types.{Action, Cancel, Listing, Payee, Purchase}

// ## Deployments

/// What ties a script context to one deployment.
pub type Deployment {
  /// The hash of the applied script: the payment part of every listing of the deployment.
  script_hash: ByteArray,
  /// The `fee_address` parameter the script was applied with.
  fee_address: Address,
}

/// `deployments/preprod-v1`: `script.json` and the fee address of `params.json`.
pub const preprod_v1: Deployment =
  Deployment {
    script_hash: #"558802cc2e2f21e4e13662cdf73f979ce0140e7dbd7ce13911a9063d",
    fee_address: Address {
      payment_credential: Script(
        #"07a947309e200dc47e2edf47b8909a8c2d46a102c3f99cd09ce68e05",
      ),
      stake_credential: Some(
        Inline(
          VerificationKey(
            #"ef136e1653cc0e3d6ea466a56d657dc3ad37c44409865c80d30d03b9",
          ),
        ),
      ),
    },
  }

// ## What the ledger hands the validator

/// One spend of the listing at `own_ref`, with the datum the ledger resolved for it.
pub type Spend {
  listing: Listing,
  action: Action,
  own_ref: OutputReference,
  transaction: Transaction,
}

/// The script context of `spend`: a spending purpose with the listing as its datum.
pub fn context(spend: Spend) -> ScriptContext {
  let redeemer: Data = spend.action
  let datum: Data = spend.listing
  ScriptContext {
    transaction: spend.transaction,
    redeemer,
    info: Spending { output: spend.own_ref, datum: Some(datum) },
  }
}

// ## The listing

const price: Int = 100_000_000

const deposit: Int = 2_000_000

const royalty_each: Int = 2_000_000

/// A royalty payee: a base address, as in `budget.test.ak`.
const payee_address: Address =
  Address {
    payment_credential: VerificationKey(creator_key),
    stake_credential: Some(Inline(VerificationKey(other_stake_key))),
  }

/// The 100 ADA public listing with `royalty_count` royalties of 2 ADA each.
fn the_listing(royalty_count: Int) -> Listing {
  listing(price, royalties(royalty_count), None)
}

fn royalties(count: Int) -> List<Payee> {
  list.repeat(Payee { address: payee_address, lovelace: royalty_each }, count)
}

/// The listing UTxO at `out_ref(0)`: the deployment's script with the seller's stake key, the NFT
/// and the deposit, and `datum`.
fn listing_utxo(d: Deployment, datum: Datum) -> Input {
  Input {
    output_reference: out_ref(0),
    output: Output {
      address: Address {
        payment_credential: Script(d.script_hash),
        stake_credential: Some(Inline(VerificationKey(seller_stake_key))),
      },
      value: merge(from_lovelace(deposit), from_asset(nft_policy, nft_name, 1)),
      datum,
      reference_script: None,
    },
  }
}

/// A wallet UTxO of `owner` holding 500 ADA. Its reference is no listing's.
fn wallet_utxo(owner: ByteArray) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
      output_index: 0,
    },
    output: ada_out(from_verification_key(owner), 500_000_000),
  }
}

/// The NFT and 2 ADA, delivered to `owner`.
fn nft_to(owner: ByteArray) -> Output {
  Output {
    address: from_verification_key(owner),
    value: merge(from_lovelace(deposit), from_asset(nft_policy, nft_name, 1)),
    datum: NoDatum,
    reference_script: None,
  }
}

// ## Purchases

/// The transaction that buys the listing with `royalty_count` royalties, paying `fee` to the fee
/// address and the seller and the royalties in full, with `datum` on the listing UTxO. With the
/// version 1 terms the fee is 1.5 ADA (the minimum) and the seller is due
/// 100 - 1.5 - 2 x `royalty_count` + 2 ADA.
fn purchase_transaction(
  d: Deployment,
  royalty_count: Int,
  fee: Int,
  datum: Datum,
) -> Transaction {
  let seller_due = price - 1_500_000 - royalty_count * royalty_each + deposit
  let payments = [
    ada_out(d.fee_address, fee),
    tagged_out(seller, seller_due, out_ref(0)),
    ..list.repeat(
      tagged_out(payee_address, royalty_each, out_ref(0)),
      royalty_count,
    )
  ]
  let change = ada_out(from_verification_key(buyer_key), 400_000_000)
  tx(
    [wallet_utxo(buyer_key), listing_utxo(d, datum)],
    list.concat(payments, [change, nft_to(buyer_key)]),
    [],
  )
}

/// Buys the listing with `royalty_count` royalties, paying `fee` to the fee address.
fn purchase(d: Deployment, royalty_count: Int, fee: Int) -> Spend {
  let l = the_listing(royalty_count)
  Spend {
    listing: l,
    action: Purchase { first_output: 1 },
    own_ref: out_ref(0),
    transaction: purchase_transaction(d, royalty_count, fee, InlineDatum(l)),
  }
}

/// A correct purchase of the listing with one royalty. Expected: success.
pub fn purchase_ok(d: Deployment) -> Spend {
  purchase(d, 1, 1_500_000)
}

/// The same purchase with no royalty. Expected: success.
pub fn purchase_no_royalty(d: Deployment) -> Spend {
  purchase(d, 0, 1_500_000)
}

/// The same purchase with three royalties, the most the wallet lists. Expected: success.
pub fn purchase_three_royalties(d: Deployment) -> Spend {
  purchase(d, 3, 1_500_000)
}

/// `purchase_ok` with a fee output one lovelace short of the 1.5 ADA fee. Expected: failure.
pub fn purchase_fee_short(d: Deployment) -> Spend {
  purchase(d, 1, 1_499_999)
}

// ## Cancels

/// The seller's wallet UTxO pays the transaction fee, and the NFT and the deposit go back to the
/// seller's own key. `signers` are the required signers of the transaction.
fn cancel_transaction(
  d: Deployment,
  datum: Datum,
  signers: List<VerificationKeyHash>,
) -> Transaction {
  tx(
    [wallet_utxo(seller_key), listing_utxo(d, datum)],
    [
      nft_to(seller_key),
      ada_out(from_verification_key(seller_key), 499_000_000),
    ],
    signers,
  )
}

/// The owner cancels the listing with one royalty, signed. Expected: success.
pub fn cancel_ok(d: Deployment) -> Spend {
  let l = the_listing(1)
  Spend {
    listing: l,
    action: Cancel,
    own_ref: out_ref(0),
    transaction: cancel_transaction(d, InlineDatum(l), [seller_key]),
  }
}

/// A signed cancel of a UTxO at the script that has no datum: the ledger hands the validator no
/// datum at all. Expected: failure, and the UTxO can never be spent.
pub fn cancel_no_datum_context(d: Deployment) -> ScriptContext {
  let redeemer: Data = Cancel
  ScriptContext {
    transaction: cancel_transaction(d, NoDatum, [seller_key]),
    redeemer,
    info: Spending { output: out_ref(0), datum: None },
  }
}

/// A signed cancel of a UTxO at the script whose inline datum is the integer 42, not a `Listing`.
/// Expected: failure. A cancel reads the owner from field 0 of the datum and an integer has no
/// fields, so even the owner's signed cancel fails and the UTxO can never be spent.
pub fn cancel_bad_datum_context(d: Deployment) -> ScriptContext {
  let redeemer: Data = Cancel
  let datum: Data = 42
  ScriptContext {
    transaction: cancel_transaction(d, InlineDatum(datum), [seller_key]),
    redeemer,
    info: Spending { output: out_ref(0), datum: Some(datum) },
  }
}

// ## Datums that are not a Listing but are a constructor

/// The five fields of the listing of `cancel_ok` followed by a sixth, so every field the script
/// reads on its own is a valid one and only the datum as a whole is not a `Listing`. Aiken cannot
/// build an ill-typed `Listing`, so the contexts below carry it as raw `Data`.
type ListingWithSixthField {
  owner: VerificationKeyHash,
  seller_address: Address,
  price: Int,
  royalties: List<Payee>,
  buyer: Option<VerificationKeyHash>,
  sixth: Int,
}

/// The inline datum of the three contexts below: constructor 0 with six fields, the first the
/// seller's key hash.
fn sixth_field_datum() -> Data {
  let l = the_listing(1)
  let datum: Data = ListingWithSixthField {
    owner: l.owner,
    seller_address: l.seller_address,
    price: l.price,
    royalties: l.royalties,
    buyer: l.buyer,
    sixth: 1,
  }
  datum
}

/// A cancel of a UTxO at the script whose inline datum is a `Listing` with a sixth field, signed
/// by the key in field 0. Expected: success. A cancel reads only that key, so the script lets its
/// owner take the UTxO back.
pub fn cancel_constr_datum_context(d: Deployment) -> ScriptContext {
  let redeemer: Data = Cancel
  let datum = sixth_field_datum()
  ScriptContext {
    transaction: cancel_transaction(d, InlineDatum(datum), [seller_key]),
    redeemer,
    info: Spending { output: out_ref(0), datum: Some(datum) },
  }
}

/// `cancel_constr_datum_context` with no signature. Expected: failure. The signature, not the
/// datum, is what moves the UTxO.
pub fn cancel_constr_datum_unsigned_context(d: Deployment) -> ScriptContext {
  let redeemer: Data = Cancel
  let datum = sixth_field_datum()
  ScriptContext {
    transaction: cancel_transaction(d, InlineDatum(datum), []),
    redeemer,
    info: Spending { output: out_ref(0), datum: Some(datum) },
  }
}

/// The purchase of `purchase_ok`, the same inputs and outputs, of a UTxO whose inline datum is the
/// `Listing` with a sixth field. Expected: failure. The fee total expects every input at the
/// script to be a `Listing`, so a datum of any other shape cannot be bought.
pub fn purchase_constr_datum_context(d: Deployment) -> ScriptContext {
  let redeemer: Data = Purchase { first_output: 1 }
  let datum = sixth_field_datum()
  ScriptContext {
    transaction: purchase_transaction(d, 1, 1_500_000, InlineDatum(datum)),
    redeemer,
    info: Spending { output: out_ref(0), datum: Some(datum) },
  }
}
