//// Shared test fixtures for the Gero listing contract.
////
//// A normal library module (not a `.test.ak` file) so that every test module can import it.
//// Nothing in the validator depends on it. Every key and script hash below is a made-up
//// 28-byte value (one byte repeated), distinct from all the others.

use aiken/cbor
use aiken/crypto.{ScriptHash, VerificationKeyHash, blake2b_256}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Assets, PolicyId, from_asset, from_lovelace, merge}
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use gero_market/tag.{listing_tag}
use gero_market/types.{Listing, Payee}

// ## Keys and hashes

/// The listing validator's own script hash.
pub const script_hash: ScriptHash =
  #"51515151515151515151515151515151515151515151515151515151"

/// A second Plutus script hash, for inputs that are not Gero listings.
pub const other_script_hash: ScriptHash =
  #"52525252525252525252525252525252525252525252525252525252"

/// The seller's payment key. Every fixture listing is owned by it.
pub const seller_key: VerificationKeyHash =
  #"61616161616161616161616161616161616161616161616161616161"

/// The seller's stake key. Listings sit at the script plus this stake credential.
pub const seller_stake_key: VerificationKeyHash =
  #"62626262626262626262626262626262626262626262626262626262"

/// A stake key that is nobody's in the fixtures: it makes an address that differs from
/// another only in its stake part.
pub const other_stake_key: VerificationKeyHash =
  #"63636363636363636363636363636363636363636363636363636363"

/// The payment key of the first royalty payee.
pub const creator_key: VerificationKeyHash =
  #"64646464646464646464646464646464646464646464646464646464"

/// The payment key of the second royalty payee.
pub const creator_b_key: VerificationKeyHash =
  #"65656565656565656565656565656565656565656565656565656565"

/// A buyer's payment key, for private sales and for the buyer's signature.
pub const buyer_key: VerificationKeyHash =
  #"66666666666666666666666666666666666666666666666666666666"

/// A key that owns nothing and is named by no datum.
pub const stranger_key: VerificationKeyHash =
  #"67676767676767676767676767676767676767676767676767676767"

/// The hash of the fee address's native script.
pub const fee_script_hash: ScriptHash =
  #"71717171717171717171717171717171717171717171717171717171"

/// The A.D. Labs stake key of the fee address.
pub const ad_stake_key: VerificationKeyHash =
  #"72727272727272727272727272727272727272727272727272727272"

/// The policy of the one NFT every fixture listing holds.
pub const nft_policy: PolicyId =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

/// The name of that NFT.
pub const nft_name: ByteArray = "gero_nft"

// ## Validator parameters

/// The v1 fee in basis points of the price.
pub const v1_fee_bps: Int = 100

/// The v1 minimum fee: 1.5 ADA.
pub const v1_min_fee: Int = 1_500_000

/// The v1 fee cap: 5 ADA.
pub const v1_max_fee: Option<Int> = Some(5_000_000)

// ## Addresses

/// The seller's address: their payment key plus their stake key.
pub const seller: Address =
  Address {
    payment_credential: VerificationKey(seller_key),
    stake_credential: Some(Inline(VerificationKey(seller_stake_key))),
  }

/// The seller's payment key with a different stake key.
pub const seller_other_stake: Address =
  Address {
    payment_credential: VerificationKey(seller_key),
    stake_credential: Some(Inline(VerificationKey(other_stake_key))),
  }

/// The first royalty payee, a plain key address.
pub const creator: Address =
  Address {
    payment_credential: VerificationKey(creator_key),
    stake_credential: None,
  }

/// The second royalty payee, a plain key address.
pub const creator_b: Address =
  Address {
    payment_credential: VerificationKey(creator_b_key),
    stake_credential: None,
  }

/// The fee address: the fee native script plus the A.D. Labs stake key.
pub const fee_addr: Address =
  Address {
    payment_credential: Script(fee_script_hash),
    stake_credential: Some(Inline(VerificationKey(ad_stake_key))),
  }

/// The fee script with a different stake key.
pub const fee_addr_other_stake: Address =
  Address {
    payment_credential: Script(fee_script_hash),
    stake_credential: Some(Inline(VerificationKey(other_stake_key))),
  }

/// Where fixture listings sit: the listing script plus the seller's stake key.
pub const listing_address: Address =
  Address {
    payment_credential: Script(script_hash),
    stake_credential: Some(Inline(VerificationKey(seller_stake_key))),
  }

// ## Builders

/// An output reference with a fixed transaction id. Different indices give different
/// references, hence different tags.
pub fn out_ref(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"6d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e",
    output_index: index,
  }
}

/// A listing owned by the seller and paid out to the seller's address.
pub fn listing(
  price: Int,
  royalties: List<Payee>,
  buyer: Option<VerificationKeyHash>,
) -> Listing {
  Listing { owner: seller_key, seller_address: seller, price, royalties, buyer }
}

/// The value of a listing UTxO: `deposit` lovelace and one NFT.
fn listing_value(deposit: Int) -> Assets {
  merge(from_lovelace(deposit), from_asset(nft_policy, nft_name, 1))
}

/// A listing UTxO with the listing as an inline datum.
pub fn listing_input(ref: OutputReference, l: Listing, deposit: Int) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: listing_address,
      value: listing_value(deposit),
      datum: InlineDatum(l),
      reference_script: None,
    },
  }
}

/// The same listing UTxO, but the datum is referenced by its hash.
pub fn hash_datum_input(ref: OutputReference, l: Listing, deposit: Int) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: listing_address,
      value: listing_value(deposit),
      datum: DatumHash(blake2b_256(cbor.serialise(l))),
      reference_script: None,
    },
  }
}

/// An ADA-only output with no datum.
pub fn ada_out(address: Address, lovelace: Int) -> Output {
  Output {
    address,
    value: from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

/// An ADA-only output carrying the tag of the listing at `ref`.
pub fn tagged_out(
  address: Address,
  lovelace: Int,
  ref: OutputReference,
) -> Output {
  Output {
    address,
    value: from_lovelace(lovelace),
    datum: InlineDatum(listing_tag(ref)),
    reference_script: None,
  }
}

/// A transaction with these inputs, outputs and signers and everything else empty.
pub fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    outputs,
    extra_signatories: signers,
  }
}
