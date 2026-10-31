//// Types of the Gero listing contract: the listing datum and the redeemer.

use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}

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
