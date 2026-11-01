// Derives the fee address of one contract version.
//
// Usage: node scripts/fee-address.mjs --network preprod|mainnet --version <N>
//          --signers <keyhash1,keyhash2,keyhash3> --stake <keyhash>
//
// The fee address is a base address. Its payment part is the hash of the native script
//
//   all [ atLeast 2 of (sig k1, sig k2, sig k3), invalidBefore <N> ]
//
// and its stake part is the given stake key. The `invalidBefore` slot is the version number: it
// gives every contract version its own script hash and address with the same signers (spec 5.9).
// It is a real timelock, not a no-op: a spend from the fee address needs a transaction whose
// validity interval has a lower bound of at least N (`invalid_before >= N`), and a transaction with
// no lower bound fails the script. The slot is far in the past, so any lower bound from N up to
// the current slot works; a sweep must set one. The three signer key hashes are sorted ascending
// before the script is built, so the order they are given in changes nothing.
//
// Prints { nativeScript, scriptHash, address } as JSON. Key hashes are 56 lowercase hex characters
// (28 bytes). Exit 0 on success; bad input exits 2 with a message on stderr.

import { credentialToAddress, scriptFromNative, validatorToScriptHash } from '@lucid-evolution/lucid';

import {
  NETWORKS,
  UsageError,
  isMain,
  parseCli,
  parseKeyHash,
  parseNetwork,
  parseVersion,
  requireOption,
  runCli,
} from './lib/deployment.mjs';

/** Three distinct key hashes from `--signers`. */
function parseSigners(text) {
  const hashes = text.split(',').map((hash) => parseKeyHash(hash, '--signers'));
  if (hashes.length !== 3) throw new UsageError('--signers must list exactly three key hashes, separated by commas');
  if (new Set(hashes).size !== 3) throw new UsageError('--signers must list three different key hashes');
  return hashes;
}

/**
 * The fee address of a version. `signers` are key hashes in any order, `stake` a stake key hash,
 * `version` a positive whole number, `network` `preprod` or `mainnet`.
 */
export function deriveFeeAddress({ network, version, signers, stake }) {
  const sorted = [...signers].sort(); // lowercase hex: string order is byte order
  const nativeScript = {
    type: 'all',
    scripts: [
      { type: 'atLeast', required: 2, scripts: sorted.map((keyHash) => ({ type: 'sig', keyHash })) },
      { type: 'after', slot: version },
    ],
  };
  const scriptHash = validatorToScriptHash(scriptFromNative(nativeScript));
  const address = credentialToAddress(
    NETWORKS[network].lucid,
    { type: 'Script', hash: scriptHash },
    { type: 'Key', hash: stake },
  );
  return { nativeScript, scriptHash, address };
}

function main() {
  const values = parseCli({
    network: { type: 'string' },
    version: { type: 'string' },
    signers: { type: 'string' },
    stake: { type: 'string' },
  });
  const network = parseNetwork(requireOption(values, 'network'));
  const version = parseVersion(requireOption(values, 'version'));
  const signers = parseSigners(requireOption(values, 'signers'));
  const stake = parseKeyHash(requireOption(values, 'stake'), '--stake');
  console.log(JSON.stringify(deriveFeeAddress({ network, version, signers, stake }), null, 2));
}

if (isMain(import.meta.url)) runCli('fee-address', main);
