//// The tag that ties a seller or royalty output to one listing.

use aiken/cbor
use aiken/crypto.{blake2b_256}
use cardano/transaction.{OutputReference}

/// The inline datum a seller or royalty output must carry to count for the listing
/// at `own_ref`: `blake2b_256` of the CBOR serialisation of the output reference's Plutus data.
///
/// That CBOR is an indefinite-length constructor, `d8799f 5820 <32-byte tx id> <uint index> ff`,
/// where the index is the shortest CBOR unsigned integer (one byte below 24, then `18 nn`,
/// `19 nnnn`, `1a nnnnnnnn`). Off-chain code must build exactly these bytes;
/// `test-vectors/tags.json` pins them for indices 0, 23, 24 and 256.
pub fn listing_tag(own_ref: OutputReference) -> ByteArray {
  blake2b_256(cbor.serialise(own_ref))
}
