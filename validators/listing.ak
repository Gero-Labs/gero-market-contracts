//// The Gero listing validator.
////
//// A listing is an NFT locked here with an inline `Listing` datum. It is spent either by a
//// purchase that pays the fee, the seller and the royalties, or by its owner cancelling it.
//// The rules live in `gero_market/spend`; this module only applies the four parameters
//// (each of which changes the script hash) and rejects every other script purpose.

use cardano/address.{Address}
use cardano/script_context.{Minting, ScriptContext}
use cardano/transaction.{OutputReference, Transaction}
use gero_market/fixtures
use gero_market/spend.{validate}
use gero_market/types.{Action, Listing}

validator listing(
  fee_address: Address,
  fee_bps: Int,
  min_fee: Int,
  max_fee: Option<Int>,
) {
  spend(
    datum: Option<Listing>,
    action: Action,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    validate(
      fee_address,
      fee_bps,
      min_fee,
      max_fee,
      datum,
      action,
      own_ref,
      self,
    )
  }

  else(_) {
    fail
  }
}

/// The script cannot be used to mint: a minting purpose reaches the `else` handler, which fails.
test else_fails() fail {
  let context = ScriptContext {
    transaction: transaction.placeholder,
    redeemer: Void,
    info: Minting(fixtures.nft_policy),
  }
  listing.else(
    fixtures.fee_addr,
    fixtures.v1_fee_bps,
    fixtures.v1_min_fee,
    fixtures.v1_max_fee,
    context,
  )
}
