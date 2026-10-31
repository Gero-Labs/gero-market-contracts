//// Spend validation of the Gero listing contract: `Purchase` and `Cancel` of one listing.
////
//// Every boolean clause that can be dropped is marked by a comment line directly above it:
//// two slashes, the word mutant, a colon and the clause id. `aiken fmt` moves a comment written
//// after a clause to the line below it, so the marker has to sit above the clause it names.
//// The mutation check replaces each marked clause with `True` and requires some test to fail.
//// Long expressions are bound with `let` above the `and` so that each marked clause stays on one line.

use aiken/collection/list
use cardano/address.{Address, Script}
use cardano/assets.{lovelace_of}
use cardano/transaction.{OutputReference, Transaction}
use gero_market/fee.{listing_fee}
use gero_market/rules.{
  lovelace_paid_to, own_output, pays, pays_each, total_fees,
}
use gero_market/tag.{listing_tag}
use gero_market/types.{Action, Cancel, Listing, Payee, Purchase}

/// Whether the listing at `own_ref` may be spent by `self` with `action`.
///
/// `datum` is what the ledger resolved for the spent output. A UTxO with no datum can never
/// be spent, whatever the action. The three parameters of the fee and the fee address are
/// those the validator was compiled with.
///
/// `Purchase { first_output }` needs all of the following:
/// - the seller's share, `price - fee - royalties`, is positive;
/// - the outputs at the fee address hold at least the fees of every listing of this script in
///   the transaction;
/// - the output at `first_output` pays the seller `share + deposit`, tagged with this listing;
/// - the outputs after it pay the royalties in order, each tagged with this listing;
/// - when the listing is private, its buyer signs.
///
/// `Cancel` needs the owner's signature and nothing else, so one transaction can cancel and relist.
///
/// A Gero input whose datum is not inline (a datum hash) can be cancelled but never bought. The
/// ledger hands this validator the datum that a hash stands for, so the `expect Some(l) = datum`
/// in the body does not reject it. What makes a `Purchase` fail is `total_fees`: it expects every
/// input at this script, the spent one and any other, to carry an inline `Listing`, and crashes
/// otherwise. Its result is `fee_due`, which the `fee-covered` clause reads, and no other line
/// looks at the datum of the other inputs. That clause must therefore keep calling `total_fees`
/// over all inputs at the script's own hash; narrowing it to the spent input would let a
/// hash-datum listing, or a transaction that carries one, be bought.
pub fn validate(
  fee_address: Address,
  fee_bps: Int,
  min_fee: Int,
  max_fee: Option<Int>,
  datum: Option<Listing>,
  action: Action,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  expect Some(l) = datum
  when action is {
    Purchase { first_output } -> {
      let tag = listing_tag(own_ref)
      let own = own_output(self.inputs, own_ref)
      expect Script(own_hash) = own.address.payment_credential
      let fee = listing_fee(l.price, fee_bps, min_fee, max_fee)
      let deposit = lovelace_of(own.value)
      let share = l.price - fee - royalty_total(l.royalties)
      let seller_due = share + deposit
      expect [seller_out, ..royalty_outs] = list.drop(
        self.outputs,
        first_output,
      )
      let fee_paid = lovelace_paid_to(self.outputs, fee_address)
      let fee_due = total_fees(self.inputs, own_hash, fee_bps, min_fee, max_fee)
      let buyer_allowed = when l.buyer is {
        None -> True
        Some(key) -> list.has(self.extra_signatories, key)
      }
      and {
        // mutant:seller-share-positive
        share > 0,
        // mutant:fee-covered
        fee_paid >= fee_due,
        // mutant:seller-paid
        pays(seller_out, l.seller_address, seller_due, tag),
        // mutant:royalties-paid
        pays_each(royalty_outs, l.royalties, tag),
        // mutant:buyer-allowed
        buyer_allowed,
      }
    }
    Cancel ->
      // mutant:cancel-owner-signed
      list.has(self.extra_signatories, l.owner)
  }
}

/// The sum of the lovelace of all `royalties`.
fn royalty_total(royalties: List<Payee>) -> Int {
  list.foldl(royalties, 0, fn(royalty, total) { total + royalty.lovelace })
}
