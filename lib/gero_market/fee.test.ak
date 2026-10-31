//// Tests for the listing fee.
////
//// The unit tests pin the worked examples of the v1 parameters (1 %, minimum 1.5 ADA,
//// cap 5 ADA): the minimum applies below 150 ADA, the cap from 500 ADA, and the fee
//// rounds down in between.
////
//// The property tests draw prices from `price_fuzzer`, which reaches all three ranges of
//// the formula (minimum, proportional band, cap) and still covers the whole supply. A plain
//// uniform draw over the supply would land in the cap range every time: the minimum and
//// proportional ranges together are about one part in 10^8 of it.

use aiken/fuzz
use gero_market/fee.{listing_fee}

/// The total ADA supply (45 billion ADA) in lovelace, the largest price a listing can have.
const max_price: Int = 45_000_000_000_000_000

/// Prices in three equally likely draws:
/// - 0 to 150 ADA, the minimum range;
/// - 140 to 510 ADA, which straddles both thresholds and holds the proportional band;
/// - 0 to the whole supply, so the largest prices stay reachable (almost every draw of this
///   one is in the cap range).
fn price_fuzzer() -> Fuzzer<Int> {
  fuzz.either3(
    fuzz.int_between(0, 150_000_000),
    fuzz.int_between(140_000_000, 510_000_000),
    fuzz.int_between(0, max_price),
  )
}

fn v1_fee(price: Int) -> Int {
  listing_fee(price, 100, 1_500_000, Some(5_000_000))
}

test fee_10_ada_is_min() {
  v1_fee(10_000_000) == 1_500_000
}

test fee_100_ada_is_min() {
  v1_fee(100_000_000) == 1_500_000
}

test fee_150_ada_exact() {
  v1_fee(150_000_000) == 1_500_000
}

test fee_151_ada() {
  v1_fee(151_000_000) == 1_510_000
}

test fee_rounds_down() {
  v1_fee(150_000_099) == 1_500_000
}

test fee_499_99_ada() {
  v1_fee(499_990_000) == 4_999_900
}

test fee_500_ada_is_cap() {
  v1_fee(500_000_000) == 5_000_000
}

test fee_5000_ada_is_cap() {
  v1_fee(5_000_000_000) == 5_000_000
}

test fee_no_cap() {
  listing_fee(5_000_000_000, 100, 1_500_000, None) == 50_000_000
}

test fee_bps_1() {
  listing_fee(10_000_000_000, 1, 0, None) == 1_000_000
}

test fee_bps_9999() {
  listing_fee(10_000, 9999, 0, None) == 9_999
}

test prop_fee_within_bounds(price via price_fuzzer()) {
  let fee = v1_fee(price)
  1_500_000 <= fee && fee <= 5_000_000
}

test prop_fee_monotonic(prices via fuzz.both(price_fuzzer(), price_fuzzer())) {
  let (a, b) = prices
  let (p1, p2) = if a <= b {
    (a, b)
  } else {
    (b, a)
  }
  v1_fee(p1) <= v1_fee(p2)
}
