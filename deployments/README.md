# Deployments

Every deployment of the Gero listing contract has its own folder here, named
`<network>-v<version>`, for example `preprod-v1`. A folder holds everything needed to match an
on-chain script hash to the source in this repository.

A deployed folder is never edited. A different fee, fee address, or contract fix is a new script, so
it gets a new version number and a new folder. The old folder stays, because listings made under it
can still be cancelled and bought until they drain. `apply-params.mjs` enforces this: it refuses
(exit 2) a folder that already holds `plutus.json` or `script.json`, and a `params.json` that
differs from the one in the folder.

## What is in a folder

| File | What it is | Written by |
|---|---|---|
| `fee-address.json` | The fee address of this version, exactly as `fee-address.mjs` prints it: the native script (three signers and the version slot), its hash, and the address with the stake key. Required: both tools below check it. | `scripts/fee-address.mjs`, output saved by hand |
| `params.json` | The four contract parameters that were applied. | by hand, reviewed |
| `plutus.json` | The blueprint with all four parameters applied. | `scripts/apply-params.mjs` |
| `script.json` | `{ scriptHash, compiledCode }`: the script hash and the compiled code of the deployed validator. | `scripts/apply-params.mjs` |

`params.json` looks like this (version 1 terms; `maxFeeLovelace` is `null` for no cap):

```json
{
  "feeAddress": "addr_test1...",
  "feeBps": 100,
  "minFeeLovelace": 1500000,
  "maxFeeLovelace": 5000000
}
```

The checks in `apply-params.mjs` and `verify-params.mjs` refuse a `params.json` that breaks the
contract's rules or the deployment review: `0 < feeBps < 10000` and `feeBps <= 1000`,
`minFeeLovelace >= 0`, `maxFeeLovelace` either `null` or at least `minFeeLovelace`, and a fee address
that is a base address with a script payment part and a key stake part on the right network.

## How the fee address is bound to the version

`apply-params.mjs` (exit 2) and `verify-params.mjs` (exit 1) both read `fee-address.json` and check,
without using the parameter encoder:

1. the native script is the fee script `all [ atLeast 2 of (sig, sig, sig), after N ]` with three
   different signers in ascending order, and its `after` slot is the version number;
2. hashing that native script again gives `scriptHash`;
3. `address` is the `feeAddress` of `params.json`, character for character;
4. the address's payment credential is that `scriptHash`.

A missing `fee-address.json` is bad input (exit 2) for both. This stops a version 2 deployment from
quietly reusing the version 1 fee address, which would let one transaction pay one fee for both
versions (spec 5.9).

## Sweeping fees from the fee address

The `after N` part of the fee script is a real timelock (`invalidBefore`, `invalid_before` in
ledger terms), not a formality. A transaction that spends from the fee address must set a validity
lower bound of at least N (`invalid_before >= N`); a transaction with no lower bound fails the
script. N is a small number (the version), so any lower bound from N up to the current slot works,
and the current slot is the natural choice. Two of the three signers must also sign.

## Procedure

Run these from the repository root. Step 4 needs Aiken v1.1.24 (the version that built
`plutus.json`) first on `PATH`; the other steps only need Node.

1. **Pick the network and the version.** The version is the next unused whole number for that
   network. It becomes the `invalidBefore` slot of the fee address, so two versions never share a
   fee address.
2. **Derive the fee address.** Pass the three signers' key hashes and the stake key hash (hashes,
   never keys). The folder must hold the output as `fee-address.json`:

   ```sh
   mkdir -p deployments/preprod-v1
   node scripts/fee-address.mjs --network preprod --version 1 \
     --signers <keyhash1>,<keyhash2>,<keyhash3> --stake <stakekeyhash> \
     > deployments/preprod-v1/fee-address.json
   ```

3. **Write `params.json`** with the `address` from `fee-address.json` and the terms for this version.
   Have it reviewed before going on.
4. **Apply the parameters** with the Aiken CLI, one parameter at a time, then hash the result:

   ```sh
   node scripts/apply-params.mjs --network preprod --version 1 \
     --params deployments/preprod-v1/params.json
   ```

   This writes `plutus.json` and `script.json` next to `params.json`. The committed `plutus.json` in
   the repository root is not touched. It first checks `fee-address.json` against the version and
   `params.json` (see above), and it refuses a folder that already holds `plutus.json` or
   `script.json`.
5. **Verify with the second implementation.** This applies the same parameters again with Lucid
   Evolution, which encodes them on its own, and compares the hashes:

   ```sh
   node scripts/verify-params.mjs --network preprod --version 1
   ```

   It must exit 0. Exit 1 prints both hashes (or the `fee-address.json` mismatch): do not publish,
   find out which encoding or file is wrong.
6. **Publish.** Only after step 5: commit the folder, upload the reference script, lock it at an
   always-fail address, and record the script hash, reference script output and source commit in the
   wallet's deployment list.

Steps 4 and 5 take `--dir <folder>` to work in another deployments folder than this one.

## Mainnet

Preprod folders are for testing. A `mainnet-v<version>` folder is created only after the independent
audit of the source commit that is being deployed, and never before. No key of any kind is kept in
this repository, only key hashes.
