//// Tests for the output tag.
////
//// The four vectors below are shared with the off-chain code through
//// `test-vectors/tags.json`. `scripts/check-vectors.mjs` rebuilds the serialised bytes
//// and tags independently and fails if the JSON and this file disagree.
////
//// Indices 0 and 23 are the smallest and largest values a CBOR unsigned integer holds in its
//// initial byte, 24 is the first that needs a length byte (`18`), and 256 is the first that
//// needs two (`19`).

use aiken/cbor
use cardano/transaction.{OutputReference}
use gero_market/tag.{listing_tag}

const tx_id: ByteArray =
  #"6d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e"

fn out_ref(index: Int) -> OutputReference {
  OutputReference { transaction_id: tx_id, output_index: index }
}

test serialise_index_0() {
  cbor.serialise(out_ref(0)) == #"d8799f58206d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e00ff"
}

test serialise_index_23() {
  cbor.serialise(out_ref(23)) == #"d8799f58206d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e17ff"
}

test serialise_index_24() {
  cbor.serialise(out_ref(24)) == #"d8799f58206d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e1818ff"
}

test serialise_index_256() {
  cbor.serialise(out_ref(256)) == #"d8799f58206d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e190100ff"
}

test tag_index_0() {
  listing_tag(out_ref(0)) == #"c41f32d0bea8c6a8d19ac76ff2e88361f122e0055e76a9d905f975a940c6235a"
}

test tag_index_23() {
  listing_tag(out_ref(23)) == #"c18341d52add65233b8db163faa0f8312581988f156655f2cd34d93b19794496"
}

test tag_index_24() {
  listing_tag(out_ref(24)) == #"6567435d1dd0ace94195d8536e584e2a8abbf9e3c56d70343dbc2e1e0fdb0433"
}

test tag_index_256() {
  listing_tag(out_ref(256)) == #"3a9bdc80a127aba51c132304405b120b06e7fb9e7baaf0fd2f43dd9569bf0b2e"
}
