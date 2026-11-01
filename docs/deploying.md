# Putting a version of the Gero listing contract on a network

This is the checklist for deploying a version, and in particular the first mainnet version. It is
written for the people at A.D. Labs who do it. The tools it uses are in `scripts/`, and
[deployments/README.md](../deployments/README.md) describes what each tool reads and writes. The
rules the contract enforces are in [rules.md](rules.md).

**Mainnet happens only after the independent audit has closed.** Nothing in this repository signs or
sends a transaction, holds a key, or touches mainnet today.

## Rules that never bend

- **A deployment folder is never edited.** `deployments/<network>-v<version>/` is created once. A
  different fee, fee address or contract fix is a new version, a new folder and a new script hash.
  The one file added to a folder after it is committed is its `deployment.json`; no existing file
  changes. `apply-params.mjs` refuses a folder that already holds `plutus.json` or `script.json`.
- **One fee address per version.** The version number is the `invalidBefore` slot of the fee
  address's native script, so two versions never share a fee address even with the same three
  signers. The tools refuse a fee record that does not match its version.
- **Key hashes only.** No key of any kind is kept in this repository, and the tools hold none. Each
  script that needs a signature writes an unsigned transaction and leaves the signing to a wallet.
- **Deploy the audited commit.** The script hash is a function of the source. Build from the commit
  the auditor reviewed, or from a commit whose difference from it the auditor has reviewed.
- **Two people for every judgement step.** Where this page says "two people", they work separately
  and compare results, and neither of them is the person who wrote the input.
- **Stop on any mismatch.** If two hashes differ, two people derive different addresses, or an
  unsigned transaction holds an output that this page does not list, stop and find out why. Do not
  edit a folder to make a check pass.

## The order

```
fee address  ->  params.json  ->  apply-params  ->  verify-params  ->  publish-reference (unsigned)
   ->  sign and submit  ->  check on chain  ->  deployment.json
```

## Preprod version 1 is the dress rehearsal

`deployments/preprod-v1/` holds a complete preprod deployment made with test keys that live outside
this repository:

| Item | Value |
|---|---|
| Script hash | `558802cc2e2f21e4e13662cdf73f979ce0140e7dbd7ce13911a9063d` |
| Fee address | `addr_test1zqr6j3esncsqm3r79m050wysn2xz634pqtpln8xsnnngup00zdhpv57vpc7kafrx54kk2lwr45mug3qfsewgp5cdqwusxeyzuc` |
| Fee native script hash | `07a947309e200dc47e2edf47b8909a8c2d46a102c3f99cd09ce68e05` |
| Terms | 100 basis points, minimum 1,500,000 lovelace, cap 5,000,000 lovelace |

Do every step below on preprod first. The rehearsal is finished when
`deployments/preprod-v1/deployment.json` exists and two people have reviewed it. Never reuse the
preprod keys on mainnet: they were generated on a development machine.

## The mainnet checklist

### 0. Before anything

- [ ] The audit is closed: the report is received, every finding is fixed or accepted in writing,
  and the commit to deploy is named.
- [ ] The preprod rehearsal is finished. On preprod, a listing has been created, repriced, cancelled,
  bought and bought privately against the preprod reference script, and a fee sweep from the preprod
  fee address has been done (see [Sweeping fees](#sweeping-fees-from-the-fee-address)).
- [ ] Work from a clean clone of the commit to deploy, on a machine you trust, with Aiken v1.1.24
  first on `PATH` (the version that built `plutus.json`; never switch the default with `aikup`).
- [ ] `npm ci`, `npm run check`, `npm test`, `node scripts/forbidden-words.mjs`,
  `node scripts/check-vectors.mjs` and `node scripts/mutation-check.mjs` all pass.
- [ ] `aiken build` leaves `plutus.json` unchanged (`git diff --exit-code plutus.json`). The
  repository's `plutus.json` is the input of every deployment, and the build has no traces. Never
  deploy a build with traces.

### 1. The people and the keys (decided by A.D. Labs, outside this repository)

- [ ] Three fee key holders are named. They are three different people on three different devices,
  because the fee address needs two of the three. Each generates the key on a hardware wallet or an
  offline device and sends only its **key hash** (56 hexadecimal characters).
- [ ] Each holder signs off their key hash: they confirm in writing that it is the hash of a key they
  control and have backed up. Recommended: each also signs a short message with the key, and a second
  person checks that the public key in the signature hashes to the stated key hash.
- [ ] The A.D. Labs stake key hash (the 28-byte hash, not the stake address) is signed off the same
  way. If the fee balance should earn staking rewards, its owner registers and delegates that stake
  credential. That is separate from the contract and from these tools.
- [ ] Every holder has confirmed a recovery path for their key. Losing two of the three keys loses fee
  revenue for good, and never user funds.

### 2. The fee address

- [ ] Two people each run, from a clean clone, with the signed-off hashes:

  ```sh
  mkdir -p deployments/mainnet-v1
  node scripts/fee-address.mjs --network mainnet --version 1 \
    --signers <keyhash1>,<keyhash2>,<keyhash3> --stake <stakekeyhash> \
    > deployments/mainnet-v1/fee-address.json
  ```

  The files must be byte for byte identical. The version is the next unused whole number on mainnet,
  which is 1 for the first mainnet deployment.
- [ ] Read `fee-address.json`: the three signers are the signed-off hashes in ascending order;
  `required` is 2; the second script is `after` with a `slot` equal to the version; the address starts
  with `addr1` and is a base address with a script payment part and the A.D. Labs stake key.
- [ ] Recompute the native script hash and the address with a tool that is not in this repository
  (for example a second library or `cardano-cli`) and compare.

### 3. The parameters

- [ ] Write `deployments/mainnet-v1/params.json` with the address from `fee-address.json` and the
  terms for this version. For version 1:

  ```json
  {
    "feeAddress": "addr1...",
    "feeBps": 100,
    "minFeeLovelace": 1500000,
    "maxFeeLovelace": 5000000
  }
  ```

  Two people review it. The tools refuse values that break the deployment review
  (`0 < feeBps <= 1000`, a cap at least the minimum, a base address with a script payment part and a key
  stake part on the right network), but they cannot tell a right value from a wrong one that is in
  range.
- [ ] Apply the parameters with the Aiken CLI:

  ```sh
  node scripts/apply-params.mjs --network mainnet --version 1 \
    --params deployments/mainnet-v1/params.json
  ```

  It checks `fee-address.json` against the version and the parameters first, then writes
  `plutus.json` and `script.json` into the folder. Exit 0.
- [ ] Verify with the second implementation, which encodes the parameters on its own (Lucid
  Evolution) and compares the script hashes:

  ```sh
  node scripts/verify-params.mjs --network mainnet --version 1
  ```

  It must exit 0. Exit 1 prints both hashes (or the fee-record mismatch): do not go on. A
  parameter that has a valid shape and a wrong value gives a valid script with another hash, and this
  check is what catches it.
- [ ] Publish a UPLC verification of the script (as for the CIP-113 deployments, for example on
  uplc.link) so that anyone can compare the deployed script with the blueprint. Keep the link, or a
  note of how the check was done: it is recorded in `uplcVerification` of `deployment.json` (step 6).
- [ ] Commit the folder (`fee-address.json`, `params.json`, `plutus.json`, `script.json`) in a pull
  request with two approvals. From here on the folder is never edited. Nothing has been signed or sent.

### 4. The reference-script transaction

`publish-reference.mjs` **refuses mainnet today**, before it reads a file or makes a provider. The
mainnet publish therefore needs a reviewed change to that script first.

- [ ] The change is made and reviewed by two people. It has to: accept `--network mainnet`; derive the
  always-fail address on mainnet; require a mainnet `--from` address (network id 1); read UTxOs and
  protocol parameters from a mainnet provider; and replace the test that expects a mainnet refusal
  with tests of the mainnet path. It must still read no key, sign nothing and submit nothing.
- [ ] Build the unsigned transaction for a funded A.D. Labs address:

  ```sh
  node scripts/publish-reference.mjs --network mainnet --version 1 --from <addr1...> > publish.cbor
  ```

  The CBOR (hex) is on stdout, and a summary on stderr: the always-fail address, the script hash, the
  lovelace of the reference output and the fee.
- [ ] Read the transaction with a decoder that is not this script (a CBOR decoder or
  `cardano-cli transaction view`). It has exactly one output at the always-fail address (the
  enterprise address of the native script `{"type":"any","scripts":[]}`, which nothing can satisfy),
  holding the PlutusV3 reference script whose hash is the `scriptHash` of `script.json`, with no datum
  and no tokens. Everything else is change back to `--from`. There are no certificates, withdrawals,
  minting, collateral or reference inputs. The lovelace in the reference output is locked for good: check the amount and
  accept it.
- [ ] The transaction is signed from an A.D. Labs wallet, preferably a hardware wallet, and
  submitted. Neither happens in this repository. Record the transaction id.

### 5. Check it on chain

- [ ] When the transaction is well settled, read it back from two independent sources. The output at
  the always-fail address (the script does not print its index; find it in the submitted
  transaction) is unspent, has no datum, and its reference script has the script hash of
  `script.json`.
- [ ] That script hash is the one of step 3: the same value in `script.json`, in the output of
  `apply-params.mjs` and `verify-params.mjs`, in the UPLC verification and on chain.

### 6. Record it

- [ ] Write `deployments/mainnet-v1/deployment.json` by hand, after the on-chain check, in exactly
  this shape (the placeholders in angle brackets are the values to fill in). No script in this
  repository writes the file, and no existing file in the folder changes.

  ```json
  {
    "network": "mainnet",
    "version": 1,
    "scriptHash": "<56 hexadecimal characters>",
    "referenceScript": "<transaction id>#<output index>",
    "referenceScriptAddress": "<the always-fail address>",
    "feeAddress": "<addr1...>",
    "feeNativeScript": { "type": "all", "scripts": ["..."] },
    "params": {
      "feeBps": 100,
      "minFeeLovelace": 1500000,
      "maxFeeLovelace": 5000000
    },
    "plutusVersion": "V3",
    "aikenVersion": "v1.1.24",
    "stdlibVersion": "v4.0.0",
    "sourceCommit": "<git commit of the build that was applied>",
    "uplcVerification": "<link, or how it was checked>"
  }
  ```

  | Field | What it holds |
  |---|---|
  | `network` | `mainnet` or `preprod`, as in the folder name |
  | `version` | the version number, as in the folder name and the `after` slot of the fee address |
  | `scriptHash` | the hash of the applied script, equal to `script.json` and to the chain |
  | `referenceScript` | the output that holds the reference script, as `<transaction id>#<output index>` |
  | `referenceScriptAddress` | the always-fail address that output sits at |
  | `feeAddress` | the fee address, equal to `feeAddress` in `params.json` |
  | `feeNativeScript` | the fee native script exactly as `fee-address.mjs` prints it, as in `fee-address.json` |
  | `params` | the three numeric terms, equal to `params.json` (`maxFeeLovelace` is `null` for no cap) |
  | `plutusVersion` | `V3` |
  | `aikenVersion` | the Aiken version that built the blueprint, `v1.1.24` |
  | `stdlibVersion` | the standard library the build used, `v4.0.0` |
  | `sourceCommit` | the git commit of the build that was applied; for mainnet, the audited commit |
  | `uplcVerification` | the link to the UPLC verification of step 3, or a note of how the script was checked |

  The date and the transaction id of the publish go in the commit message that adds the file, not in
  the file.
- [ ] Two people compare every field of `deployment.json` with the chain and with the rest of the
  folder (hash, output reference and address, fee address and native script, parameters, versions,
  commit, verification) before it is committed.
- [ ] Only then does Gero Wallet add the deployment to its list, held to the review bar of the
  CIP-113 deployments. New listings go to the newest deployment, and older ones stay in the list until
  their listings drain.

### 7. Before the wallet turns it on

- [ ] With an A.D. Labs NFT at a low price: list, reprice, cancel and buy on mainnet, and check the
  fee output, the seller's proceeds and the returned deposit against [rules.md](rules.md).
- [ ] Each supported hardware wallet has signed a real listing, cancel and buy on preprod and then on
  mainnet before it is enabled.

## Sweeping fees from the fee address

The `invalidBefore` part of the fee address's native script is a real timelock: a transaction that
spends from the fee address must set a validity lower bound of at least the version number (for
version 1, `invalid_before >= 1`), and a transaction with no lower bound fails the script. The
version is a small number, so any lower bound from there up to the current slot works, and the
current slot is the natural choice. Two of the three signers must also sign. Rehearse a sweep on
preprod with the preprod fee address before relying on it.

## A later version

A new fee, a new fee address or a contract fix is a new version: the next whole number, a new
folder, a new fee address (its `invalidBefore` slot is the new version), a new script hash and a new
checklist run. The old folder stays as it is. The wallet keeps the old deployment in its list until
its listings drain, so their owners can still cancel and buyers can still buy.
