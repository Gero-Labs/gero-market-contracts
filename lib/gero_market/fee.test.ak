//// Tests for the listing fee.
////
//// The unit tests pin the worked examples of the v1 parameters (1 %, minimum 1.5 ADA,
//// cap 5 ADA): the minimum applies below 150 ADA, the cap from 500 ADA, and the fee
//// rounds down in between. The property tests cover the whole range of prices a listing
//// can have (the total ADA supply is 45 billion ADA, so 45e15 lovelace).

use aiken/fuzz
use gero_market/fee.{listing_fee}

const max_price: Int = 45_000_000_000_000_000

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

test prop_fee_within_bounds(price via fuzz.int_between(0, max_price)) {
  let fee = v1_fee(price)
  1_500_000 <= fee && fee <= 5_000_000
}

test prop_fee_monotonic(
  prices via fuzz.both(
    fuzz.int_between(0, max_price),
    fuzz.int_between(0, max_price),
  ),
) {
  let (p1, p2) = prices
  p1 > p2 || v1_fee(p1) <= v1_fee(p2)
}
