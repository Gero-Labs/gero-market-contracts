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
versions (see [the combined fee](../docs/rules.md#p3-the-combined-fee)). The full checklist for a
deployment is in [docs/deploying.md](../docs/deploying.md).

## Sweeping fees from the fee address

The `after N` part of the fee script is a real timelock (`invalidBefore`, `invalid_before` in
ledger terms), not a formality. A transaction that spends from the fee address must set a validity
lower bound of at least N (`invalid_before >= N`); a transaction with no lower bound fails the
script. N is a small number (the version), so any lower bound from N up to the current slot works,
and the current slot is the natural choice. Two of the three signers must also sign.

## Procedure

Run these from the repository root. Steps 4 and 6 need Aiken v1.1.24 (the version that built
`plutus.json`) first on `PATH`, and step 6 also runs `aiken check` to make the context pins; the
other steps only need Node.

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
   find out which encoding or file is wrong. CI runs `verify-deployments.mjs`, which does this for
   every folder here that holds a `script.json`.
6. **Run the applied script.** Add the script contexts of this deployment (built with its script
   hash and fee address in `lib/gero_market/contexts.ak`, pinned in
   `lib/gero_market/contexts.test.ak`, saved as `test-vectors/contexts/<network>-v<N>/*.hex`; the
   step is described in [docs/deploying.md](../docs/deploying.md#3-the-parameters)), then:

   ```sh
   node scripts/eval-applied.mjs
   ```

   It runs `compiledCode` of every `script.json` on its contexts with Aiken's evaluator and must
   exit 0. CI runs it too, and fails for a folder with a `script.json` but no contexts.
7. **Publish.** Only after step 6: commit the folder, then upload the reference script and lock it
   at an always-fail address. `publish-reference.mjs` builds that transaction, unsigned, for a
   preprod address that holds funds. It reads no key, signs nothing, and refuses mainnet:

   ```sh
   node scripts/publish-reference.mjs --network preprod --version 1 --from <addr_test1...> > publish.cbor
   ```

   The transaction CBOR (hex) goes to stdout. A summary goes to stderr: the always-fail address,
   the script hash, the lovelace of the reference script output, the change and the fee. The output
   sits at the enterprise address of the native script `{"type":"any","scripts":[]}`, which nothing
   can satisfy, with no datum. The owner of `--from` signs and sends it elsewhere. Then record the
   script hash, the reference script output and the source commit in the wallet's deployment list.

   The rest of the funds go back to `--from` as change. If what is left is too little for a change
   output of its own (an address funded with just enough, such as the 10 tADA of the preprod
   deployer), there is no change output and that leftover is paid as fee; the summary says so. The
   script refuses a transaction whose fee is above 1 ADA, so the leftover cannot be large. A
   deployer that holds more than the output, the fee and the ledger minimum for one more output
   always gets its change back.

Steps 4 to 6 take `--dir <folder>` to work in another deployments folder than this one.

## Mainnet

Preprod folders are for testing. A `mainnet-v<version>` folder is created only after the independent
audit of the source commit that is being deployed, and never before. No key of any kind is kept in
this repository, only key hashes.
