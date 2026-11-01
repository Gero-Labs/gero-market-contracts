import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { getAddressDetails } from '@lucid-evolution/lucid';

import {
  assertBadInput,
  baseAddress,
  madeUpKeyHash,
  nativeScriptHash,
  parseJsonOutput,
  runScript,
  splitBaseAddress,
  symlinkedRepo,
  tempDirs,
} from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

const [SIGNER_A, SIGNER_B, SIGNER_C] = ['signer-a', 'signer-b', 'signer-c'].map(madeUpKeyHash);
const STAKE = madeUpKeyHash('stake');

// The `--name=value` form lets a value start with "-" or be empty, so bad values reach the script.
function feeAddress({ network = 'preprod', version = 1, signers = [SIGNER_A, SIGNER_B, SIGNER_C], stake = STAKE } = {}) {
  return runScript('fee-address.mjs', [
    `--network=${network}`,
    `--version=${version}`,
    `--signers=${signers.join(',')}`,
    `--stake=${stake}`,
  ]);
}

function derive(options) {
  const result = feeAddress(options);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  return parseJsonOutput(result);
}

test('the documented command line (separate values) prints exactly nativeScript, scriptHash and address', () => {
  const result = runScript('fee-address.mjs', [
    '--network', 'preprod',
    '--version', '1',
    '--signers', [SIGNER_A, SIGNER_B, SIGNER_C].join(','),
    '--stake', STAKE,
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const out = parseJsonOutput(result);
  assert.deepEqual(out, derive());
  assert.deepEqual(Object.keys(out).sort(), ['address', 'nativeScript', 'scriptHash']);
  assert.match(out.scriptHash, /^[0-9a-f]{56}$/);
  assert.match(out.address, /^addr_test1[0-9a-z]+$/);
});

test('the native script is all [ atLeast 2 of three signatures, after <version> ] with sorted key hashes', () => {
  const sorted = [SIGNER_A, SIGNER_B, SIGNER_C].sort();
  assert.deepEqual(derive({ version: 7 }).nativeScript, {
    type: 'all',
    scripts: [
      { type: 'atLeast', required: 2, scripts: sorted.map((keyHash) => ({ type: 'sig', keyHash })) },
      { type: 'after', slot: 7 },
    ],
  });
});

test('the same signers with version 1 and version 2 give different script hashes and addresses', () => {
  const v1 = derive({ version: 1 });
  const v2 = derive({ version: 2 });
  assert.notEqual(v1.scriptHash, v2.scriptHash);
  assert.notEqual(v1.address, v2.address);
});

test('swapping the order of the signers changes nothing (they are sorted before building)', () => {
  const orders = [
    [SIGNER_A, SIGNER_B, SIGNER_C],
    [SIGNER_C, SIGNER_B, SIGNER_A],
    [SIGNER_B, SIGNER_C, SIGNER_A],
  ];
  const results = orders.map((signers) => derive({ signers }));
  for (const result of results) assert.deepEqual(result, results[0]);
  const listed = results[0].nativeScript.scripts[0].scripts.map((s) => s.keyHash);
  assert.deepEqual(listed, [...listed].sort(), 'key hashes are ascending');
});

test('the address stake part is the given key, the payment part is the native script hash', () => {
  const out = derive();
  const { header, paymentHash, stakeHash } = splitBaseAddress(out.address);
  assert.equal(stakeHash, STAKE);
  assert.equal(paymentHash, out.scriptHash);
  assert.equal(header >> 4, 1, 'address type 1: script payment part, key stake part');
  const details = getAddressDetails(out.address);
  assert.deepEqual(details.paymentCredential, { type: 'Script', hash: out.scriptHash });
  assert.deepEqual(details.stakeCredential, { type: 'Key', hash: STAKE });
});

test('the script hash and address match a native script built by hand', () => {
  const sorted = [SIGNER_A, SIGNER_B, SIGNER_C].sort();
  // Versions around the CBOR width boundaries of the slot number.
  for (const version of [1, 23, 24, 255, 256, 65535, 65536]) {
    const out = derive({ version });
    const expected = nativeScriptHash(sorted, version);
    assert.equal(out.scriptHash, expected, `version ${version}`);
    assert.equal(out.address, baseAddress({ network: 'preprod', type: 1, paymentHash: expected, stakeHash: STAKE }));
  }
});

test('mainnet and preprod share the script hash and differ in network and prefix', () => {
  const preprod = derive({ network: 'preprod' });
  const mainnet = derive({ network: 'mainnet' });
  assert.equal(preprod.scriptHash, mainnet.scriptHash);
  assert.match(mainnet.address, /^addr1[0-9a-z]+$/);
  assert.equal(splitBaseAddress(preprod.address).header, 0x10);
  assert.equal(splitBaseAddress(mainnet.address).header, 0x11);
  assert.equal(
    mainnet.address,
    baseAddress({ network: 'mainnet', type: 1, paymentHash: mainnet.scriptHash, stakeHash: STAKE }),
  );
});

test('a different stake key changes the address and not the script hash', () => {
  const a = derive({ stake: madeUpKeyHash('stake') });
  const b = derive({ stake: madeUpKeyHash('other-stake') });
  assert.equal(a.scriptHash, b.scriptHash);
  assert.notEqual(a.address, b.address);
});

test('a different signer changes the script hash', () => {
  const a = derive();
  const b = derive({ signers: [SIGNER_A, SIGNER_B, madeUpKeyHash('signer-d')] });
  assert.notEqual(a.scriptHash, b.scriptHash);
});

test('bad input exits 2 with a message on stderr and nothing on stdout', () => {
  const upper = SIGNER_A.toUpperCase();
  const cases = [
    ['network that is not preprod or mainnet', { network: 'preview' }, /network/],
    ['empty network', { network: '' }, /network/],
    ['version 0', { version: 0 }, /version/],
    ['negative version', { version: -1 }, /version/],
    ['fractional version', { version: '1.5' }, /version/],
    ['version with exponent', { version: '1e3' }, /version/],
    ['version with a leading zero', { version: '01' }, /version/],
    ['version that is not a number', { version: 'one' }, /version/],
    ['version past the safe cap', { version: 1_000_001 }, /version/],
    ['two signers', { signers: [SIGNER_A, SIGNER_B] }, /signers/],
    ['four signers', { signers: [SIGNER_A, SIGNER_B, SIGNER_C, madeUpKeyHash('signer-d')] }, /signers/],
    ['a repeated signer', { signers: [SIGNER_A, SIGNER_B, SIGNER_A] }, /signers/],
    ['an upper case signer', { signers: [upper, SIGNER_B, SIGNER_C] }, /signers/],
    ['a short signer', { signers: [SIGNER_A.slice(2), SIGNER_B, SIGNER_C] }, /signers/],
    ['a signer that is not hex', { signers: ['zz'.repeat(28), SIGNER_B, SIGNER_C] }, /signers/],
    ['a short stake key', { stake: STAKE.slice(2) }, /stake/],
    ['a stake key that is not hex', { stake: 'zz'.repeat(28) }, /stake/],
  ];
  for (const [label, options, pattern] of cases) {
    assertBadInput(feeAddress(options), pattern, label);
  }
});

test('missing or unknown options exit 2', () => {
  const full = ['--network', 'preprod', '--version', '1', '--signers', [SIGNER_A, SIGNER_B, SIGNER_C].join(','), '--stake', STAKE];
  assertBadInput(runScript('fee-address.mjs', []), /network|usage/i, 'no options');
  for (const option of ['--network', '--version', '--signers', '--stake']) {
    const at = full.indexOf(option);
    const without = full.filter((_, index) => index !== at && index !== at + 1);
    assertBadInput(runScript('fee-address.mjs', without), new RegExp(option.slice(2)), `missing ${option}`);
  }
  assertBadInput(runScript('fee-address.mjs', [...full, '--bogus', 'x']), /bogus/, 'unknown option');
  assertBadInput(runScript('fee-address.mjs', [...full, 'stray']), /stray|positional/i, 'stray argument');
});

test('started through a symlink to the repo it still runs and prints the same result', () => {
  const repo = symlinkedRepo(dirs.make('fee-address-link-'));
  const args = [
    '--network=preprod',
    '--version=1',
    `--signers=${[SIGNER_A, SIGNER_B, SIGNER_C].join(',')}`,
    `--stake=${STAKE}`,
  ];
  const result = runScript('fee-address.mjs', args, { repo });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(parseJsonOutput(result), derive());
  assertBadInput(runScript('fee-address.mjs', ['--network=preview', ...args.slice(1)], { repo }), /network/, 'bad input is still refused');
});
