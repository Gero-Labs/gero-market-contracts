//// The listing fee, as a pure function of the price and the compile-time parameters.

use aiken/math

/// The fee A.D. Labs is owed for a sale at `price`:
/// `clamp(min_fee, max_fee, floor(price * fee_bps / 10000))`.
///
/// `/` on non-negative integers rounds down, which is the rounding the spec asks for.
/// The minimum is applied first and the cap last, so a cap below the minimum (a bad
/// parameter set the deployment review rejects) would win. With no cap only the minimum applies.
pub fn listing_fee(
  price: Int,
  fee_bps: Int,
  min_fee: Int,
  max_fee: Option<Int>,
) -> Int {
  let proportional = price * fee_bps / 10_000
  let at_least_min = math.max(proportional, min_fee)
  when max_fee is {
    Some(cap) -> math.min(at_least_min, cap)
    None -> at_least_min
  }
}
