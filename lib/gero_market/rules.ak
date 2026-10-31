//// Output, royalty and combined-fee rules of the Gero listing contract.
////
//// Every boolean clause that can be dropped is marked by a comment line directly above it:
//// two slashes, the word mutant, a colon and the clause id. `aiken fmt` moves a comment written
//// after a clause to the line below it, so the marker has to sit above the clause it names.
//// The mutation check replaces each marked clause with `True` and requires some test to fail.

use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Address, Script}
use cardano/assets.{is_zero, lovelace_of, without_lovelace}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, resolve_input,
}
use gero_market/fee.{listing_fee}
use gero_market/types.{Listing, Payee}

/// Whether `out` is a payment of at least `amount` lovelace to `address` that
/// counts for the listing whose tag is `tag`.
///
/// The address is compared whole (payment and stake part), the value must be ADA only,
/// and the datum must be the inline tag. More than `amount` is accepted.
pub fn pays(out: Output, address: Address, amount: Int, tag: ByteArray) -> Bool {
  and {
    // mutant:pays-address
    out.address == address,
    // mutant:pays-ada-only
    is_zero(without_lovelace(out.value)),
    // mutant:pays-amount
    lovelace_of(out.value) >= amount,
    // mutant:pays-tag
    out.datum == InlineDatum(tag),
  }
}

/// Whether `outs` start with one tagged payment per royalty, in the order of `royalties`.
///
/// Outputs after the last royalty are ignored. Every royalty must be positive: a negative
/// one would raise the seller's due above what the price advertises.
pub fn pays_each(
  outs: List<Output>,
  royalties: List<Payee>,
  tag: ByteArray,
) -> Bool {
  when royalties is {
    [] -> True
    [royalty, ..rest] ->
      when outs is {
        [] -> False
        [out, ..others] -> and {
            // mutant:royalty-positive
            royalty.lovelace > 0,
            // mutant:royalty-paid
            pays(out, royalty.address, royalty.lovelace, tag),
            // mutant:royalty-rest
            pays_each(others, rest, tag),
          }
      }
  }
}

/// The lovelace of all `outputs` whose whole address equals `address`.
pub fn lovelace_paid_to(outputs: List<Output>, address: Address) -> Int {
  list.foldl(
    outputs,
    0,
    fn(out, paid) {
      if out.address == address {
        paid + lovelace_of(out.value)
      } else {
        paid
      }
    },
  )
}

/// The sum of the fees of every input at the script `own_hash`, whatever its stake part
/// and whatever redeemer it is spent with.
///
/// Each such input must carry an inline `Listing` datum; a datum hash, no datum or any other
/// datum makes the whole call fail.
pub fn total_fees(
  inputs: List<Input>,
  own_hash: ScriptHash,
  fee_bps: Int,
  min_fee: Int,
  max_fee: Option<Int>,
) -> Int {
  list.foldl(
    inputs,
    0,
    fn(input, total) {
      if input.output.address.payment_credential == Script(own_hash) {
        expect InlineDatum(datum) = input.output.datum
        expect l: Listing = datum
        total + listing_fee(l.price, fee_bps, min_fee, max_fee)
      } else {
        total
      }
    },
  )
}

/// The output of the input at `own_ref`. Fails when `own_ref` is not among `inputs`.
pub fn own_output(inputs: List<Input>, own_ref: OutputReference) -> Output {
  resolve_input(inputs, own_ref)
}
