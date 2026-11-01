# Gero listing contract

The on-chain contract behind NFT listings in Gero Wallet. It is a Plutus V3 validator written in
[Aiken](https://aiken-lang.org) for Cardano, and it is licensed under Apache-2.0.

This is an independent implementation, written from the specification in
[docs/rules.md](docs/rules.md). The repository is public from the first commit so that anyone can
match a deployed script hash to the source in this repository.

## What the contract does

A seller lists an NFT by sending it to the contract's script address together with a small ADA
deposit and an inline datum that describes the listing:

- `owner`: the seller's payment key hash. Only this key can cancel the listing.
- `seller_address`: where the seller's proceeds, and the deposit, are paid.
- `price`: what the buyer pays to the payees, in lovelace (fee, royalties and the seller's share).
- `royalties`: creator royalties, each an address and an amount. The list may be empty.
- `buyer`: optional. For a private sale, only this key can buy. Empty means a public listing.

A buyer then spends the listing and pays what the rules below ask for. Or the owner cancels it.

The contract runs only when a listing is spent. It cannot check a listing when it is created, so
Gero Wallet verifies the datum against what the seller chose before it asks for a signature.
Funds sent to the script address without a valid listing datum can be locked for good: the wallet
never does this, and nobody should do it by hand.

## Fee terms (version 1)

| Item | Value |
|---|---|
| Fee | 1% of the listing price (100 basis points), rounded down |
| Minimum | 1.5 ADA |
| Cap | 5 ADA |
| Paid to | The A.D. Labs fee address of that contract version |

The minimum applies to prices below 150 ADA and the cap applies from 500 ADA. For example:

| Price | Fee |
|---|---|
| 10 ADA | 1.5 ADA (minimum) |
| 100 ADA | 1.5 ADA (minimum) |
| 300 ADA | 3 ADA |
| 500 ADA | 5 ADA (cap) |
| 5,000 ADA | 5 ADA (cap) |

The fee address is a native script that needs two of three A.D. Labs keys, with an A.D. Labs
stake credential so the collected fees earn staking rewards. Every contract version has its own
fee address, so a transaction that buys listings of two versions cannot pay one fee for both.

## The rules in plain words

### Buying (`Purchase`)

1. **The fee is paid.** A listing's fee is worked out from its price and the contract's fee terms.
   The transaction must pay the fee address at least the sum of the fees of **every listing input of
   this contract in the transaction, whatever its redeemer**, not only the listings being bought.
   So one fee output can cover several listings bought together, and a listing cancelled in the same
   transaction adds its fee too (the wallet never mixes the two).
2. **The seller is paid.** The seller output goes to `seller_address`. It holds at least the price
   minus the fee minus the royalties, plus the ADA deposit that was locked with the NFT, so the
   deposit goes back to the seller. This amount is computed from the datum and the contract's
   terms, never from what the buyer happened to pay, so overpaying the fee cannot shortchange the
   seller.
3. **Royalties are paid.** Each royalty output follows the seller output, in datum order, and pays
   its address at least its amount. Every royalty must be more than zero.
4. **The seller's share must be positive.** A listing whose royalties and fee leave nothing for the
   seller can never be bought. The owner can still cancel it.
5. **Outputs are tagged.** The seller and royalty outputs are ADA only and carry an inline datum
   that is unique to the listing (a hash of the listing's own output reference). One output can
   therefore never count for two listings bought in the same transaction.
6. **Private sale.** If the listing names a `buyer`, that key must sign the transaction.

Where the NFT goes is not checked. The buyer chooses.

### Cancelling (`Cancel`)

The owner's signature is required, and nothing else. There are no output rules, so the same
transaction can send the NFT anywhere, or list it again at a new price (a reprice).

### Everything else

Minting, withdrawing, certificates, votes and proposals with this script all fail, so it cannot be
used for anything but holding listings.

## Documentation

| Page | What it is for |
|---|---|
| [docs/rules.md](docs/rules.md) | The specification: parameters, types, every rule with examples, and what the contract cannot enforce |
| [docs/threat-model.md](docs/threat-model.md) | The threats, what stops each one, and the behaviours a reviewer should look at |
| [docs/test-inventory.md](docs/test-inventory.md) | Every rule and threat mapped to its tests and mutation checks, with the mutation-check output |
| [docs/budget.md](docs/budget.md) | Execution cost, and the limit on buying several listings in one transaction |
| [docs/deploying.md](docs/deploying.md) | The checklist for putting a version on a network, mainnet included |

## Parameters

The validator takes these parameters, in this order. They are applied when the script is compiled,
so changing any of them gives a new script hash. There is no fee field in the datum and no way to
waive the fee.

| Parameter | Meaning |
|---|---|
| `fee_address` | The fee address, compared as a full address (payment and stake parts) |
| `fee_bps` | Fee in basis points of the price |
| `min_fee` | Minimum fee in lovelace |
| `max_fee` | Optional cap in lovelace |

## Build and test

You need [Aiken](https://aiken-lang.org) v1.1.24 and Node.js 22.

```sh
npm ci
npm run check   # aiken fmt --check, aiken check, aiken build (warnings are errors)
npm test        # tests for the scripts in scripts/
node scripts/forbidden-words.mjs   # repository hygiene check that CI also runs
node scripts/mutation-check.mjs    # replaces each marked clause with True; a test must fail (CI runs it)
```

`aiken build` writes the blueprint to `plutus.json`. The toolchain is pinned in `aiken.toml`:
compiler v1.1.24, Plutus V3, standard library v4.0.0 and fuzz v3.0.0.

JavaScript dependencies are exact versions, each at least 14 days old when it was added. The
`overrides` in `package.json` pin three packages that Lucid Evolution pulls in with open version
ranges (`effect`, `multipasta`, `cbor-x`), so that `npm install` cannot float past that rule.
Change them together with the dependency that needs them. `@lucid-evolution/provider` is a direct
dependency at the exact version Lucid Evolution itself pins (0.4.1), so there is one copy of it.

## Deployments

Every deployment is recorded under `deployments/` (the tools are described in
[deployments/README.md](deployments/README.md) and the full checklist is in
[docs/deploying.md](docs/deploying.md)): the script hash, the parameter values, the
reference script's output reference and the source commit. A different fee, fee address or contract
fix is a new deployment with a new script hash. Older deployments stay listed so that their
listings can still be cancelled and bought.

## License

Apache-2.0. See [LICENSE](LICENSE).
