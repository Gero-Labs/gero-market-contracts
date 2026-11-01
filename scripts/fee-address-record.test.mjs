import assert from 'node:assert/strict';
import { test } from 'node:test';

import { credentialToAddress, scriptFromNative, validatorToScriptHash } from '@lucid-evolution/lucid';

import { feeAddressProblems } from './lib/deployment.mjs';
import {
  baseAddress,
  feeAddressFor,
  madeUpKeyHash,
  nativeScriptHash,
  splitBaseAddress,
} from './test-helpers.mjs';

// The check that binds a deployment's fee-address.json to its version and to params.json. These
// tests call the function directly; the apply-params and verify-params tests run it through the
// scripts. Every record is built by hand or taken from the real fee-address script, and tampered
// copies are made here, so a test never compares the check with itself.

const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
const clone = (value) => structuredClone(value);

/** A valid record with its params.json feeAddress and the options the check takes. */
function deployment(network = 'preprod', version = 1) {
  const record = feeAddressFor(network, version);
  return { record, options: { version, feeAddress: record.address } };
}

/** The record of a native script built (and hashed, and addressed) by Lucid Evolution from `script`. */
function recordFor(script, network = 'preprod', stake = madeUpKeyHash('stake')) {
  const scriptHash = validatorToScriptHash(scriptFromNative(script));
  const address = credentialToAddress(network === 'mainnet' ? 'Mainnet' : 'Preprod', { type: 'Script', hash: scriptHash }, { type: 'Key', hash: stake });
  return { nativeScript: script, scriptHash, address };
}

const mentions = (problems, pattern) => problems.some((problem) => pattern.test(problem));

test('a record from the real fee-address script passes for every version and both networks', () => {
  for (const network of ['preprod', 'mainnet']) {
    for (const version of [1, 2, 23, 24, 255, 256, 65536, 1_000_000]) {
      const { record, options } = deployment(network, version);
      assert.deepEqual(feeAddressProblems(record, options), [], `${network} v${version}`);
    }
  }
});

test('the version is the after slot: a record for another version is refused', () => {
  const { record, options } = deployment('preprod', 1);
  for (const version of [2, 3, 24, 1_000_000]) {
    const problems = feeAddressProblems(record, { ...options, version });
    assert.ok(mentions(problems, /version/i), `version ${version}: ${problems.join(' | ')}`);
  }
  // A record that is right in itself, for version 2, in a version 1 deployment.
  const other = feeAddressFor('preprod', 2);
  const problems = feeAddressProblems(other, { version: 1, feeAddress: other.address });
  assert.ok(mentions(problems, /after slot 2.*version 1/i), problems.join(' | '));
});

test('a tampered native script no longer hashes to scriptHash', () => {
  const { record, options } = deployment();
  const signer = clone(record);
  signer.nativeScript.scripts[0].scripts[1].keyHash = madeUpKeyHash('someone-else');
  signer.nativeScript.scripts[0].scripts.sort((a, b) => (a.keyHash < b.keyHash ? -1 : 1)); // keep the order fee-address.mjs makes
  assert.ok(mentions(feeAddressProblems(signer, options), /hash/i), 'a signer swapped');

  const slot = clone(record);
  slot.nativeScript.scripts[1].slot = 2;
  const problems = feeAddressProblems(slot, options);
  assert.ok(mentions(problems, /version/i), 'the slot no longer matches the version');
  assert.ok(mentions(problems, /hash/i), 'and the hash does not follow it');

  const hash = clone(record);
  hash.scriptHash = flip(record.scriptHash);
  assert.ok(mentions(feeAddressProblems(hash, options), /hash/i), 'scriptHash edited');
});

test('a native script that is self-consistent but not the fee script is refused by its shape', () => {
  const { record, options } = deployment();
  const [a, b, c] = record.nativeScript.scripts[0].scripts.map((s) => s.keyHash);
  const sig = (keyHash) => ({ type: 'sig', keyHash });
  const shapes = {
    'one of three': { type: 'all', scripts: [{ type: 'atLeast', required: 1, scripts: [a, b, c].map(sig) }, { type: 'after', slot: 1 }] },
    'three of three': { type: 'all', scripts: [{ type: 'atLeast', required: 3, scripts: [a, b, c].map(sig) }, { type: 'after', slot: 1 }] },
    'two signers only': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b].map(sig) }, { type: 'after', slot: 1 }] },
    'no time lock': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b, c].map(sig) }] },
    'before, not after': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b, c].map(sig) }, { type: 'before', slot: 1 }] },
    'any, not all': { type: 'any', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b, c].map(sig) }, { type: 'after', slot: 1 }] },
    'signers out of order': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [b, a, c].map(sig) }, { type: 'after', slot: 1 }] },
    'a repeated signer': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, a, b].map(sig) }, { type: 'after', slot: 1 }] },
    'an extra script': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b, c].map(sig) }, { type: 'after', slot: 1 }, { type: 'sig', keyHash: madeUpKeyHash('extra') }] },
    'an extra field': { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b, c].map(sig) }, { type: 'after', slot: 1 }], extra: true },
  };
  for (const [label, script] of Object.entries(shapes)) {
    const problems = feeAddressProblems(recordFor(script), { ...options, feeAddress: recordFor(script).address });
    assert.ok(mentions(problems, /native script/i), `${label}: ${problems.join(' | ')}`);
  }
  // The control: the same builder, the right shape, is accepted.
  const right = recordFor(shapes['signers out of order'] && { type: 'all', scripts: [{ type: 'atLeast', required: 2, scripts: [a, b, c].sort().map(sig) }, { type: 'after', slot: 1 }] });
  assert.deepEqual(feeAddressProblems(right, { ...options, feeAddress: right.address }), []);
});

test('the script hash is checked against a hash written by hand, not only against Lucid', () => {
  const { record, options } = deployment('preprod', 24);
  const keyHashes = record.nativeScript.scripts[0].scripts.map((s) => s.keyHash);
  assert.equal(nativeScriptHash(keyHashes, 24), record.scriptHash);
  assert.deepEqual(feeAddressProblems(record, { ...options, version: 24 }), []);
});

test('the address must be params.json feeAddress', () => {
  const { record, options } = deployment('preprod', 1);
  const other = feeAddressFor('preprod', 2).address;
  const problems = feeAddressProblems(record, { ...options, feeAddress: other });
  assert.ok(mentions(problems, /params\.json feeAddress/i), problems.join(' | '));

  const edited = clone(record);
  edited.address = other;
  assert.ok(mentions(feeAddressProblems(edited, options), /params\.json feeAddress/i), 'the record address edited');

  assert.ok(mentions(feeAddressProblems(record, { ...options, feeAddress: record.address.toUpperCase() }), /params\.json feeAddress/i), 'not the same string');
});

test('the address must pay to the script hash', () => {
  const { record, options } = deployment('preprod', 1);
  const { stakeHash } = splitBaseAddress(record.address);
  const elsewhere = baseAddress({ network: 'preprod', type: 1, paymentHash: madeUpKeyHash('elsewhere'), stakeHash });
  const forged = { ...record, address: elsewhere };
  // params.json carries the same forged address, so only the payment credential gives it away.
  const problems = feeAddressProblems(forged, { ...options, feeAddress: elsewhere });
  assert.ok(mentions(problems, /payment/i), problems.join(' | '));

  // A key payment credential (type 0) with the script hash bytes is still not a script address.
  const asKey = baseAddress({ network: 'preprod', type: 0, paymentHash: record.scriptHash, stakeHash });
  assert.ok(mentions(feeAddressProblems({ ...record, address: asKey }, { ...options, feeAddress: asKey }), /payment/i), 'key credential');
});

test('a record that is not the shape fee-address.mjs prints gives problems and never throws', () => {
  const { record, options } = deployment();
  const without = (key) => (({ [key]: _, ...rest }) => rest)(record);
  const cases = {
    null: null,
    'an array': [],
    'a string': 'fee-address',
    'a number': 7,
    'no nativeScript': without('nativeScript'),
    'no scriptHash': without('scriptHash'),
    'no address': without('address'),
    'an extra field': { ...record, note: 'edited' },
    'nativeScript null': { ...record, nativeScript: null },
    'nativeScript a string': { ...record, nativeScript: 'all' },
    'nativeScript an array': { ...record, nativeScript: [] },
    'scriptHash a number': { ...record, scriptHash: 1 },
    'scriptHash short': { ...record, scriptHash: record.scriptHash.slice(2) },
    'scriptHash upper case': { ...record, scriptHash: record.scriptHash.toUpperCase() },
    'address null': { ...record, address: null },
    'address not an address': { ...record, address: 'addr_test1notanaddress' },
    'slot a string': { ...record, nativeScript: { ...record.nativeScript, scripts: [record.nativeScript.scripts[0], { type: 'after', slot: '1' }] } },
    'slot a fraction': { ...record, nativeScript: { ...record.nativeScript, scripts: [record.nativeScript.scripts[0], { type: 'after', slot: 1.5 }] } },
    'key hash upper case': (() => {
      const copy = clone(record);
      copy.nativeScript.scripts[0].scripts[0].keyHash = copy.nativeScript.scripts[0].scripts[0].keyHash.toUpperCase();
      return copy;
    })(),
  };
  for (const [label, bad] of Object.entries(cases)) {
    let problems;
    assert.doesNotThrow(() => { problems = feeAddressProblems(bad, options); }, label);
    assert.ok(problems.length > 0, `${label} must give a problem`);
    assert.ok(problems.every((p) => typeof p === 'string' && p.length > 0), label);
  }
});

test('prototype keys in a record are refused and pollute nothing', () => {
  const { record, options } = deployment();
  const raw = JSON.stringify(record).slice(1, -1);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const parsed = JSON.parse(`{"${key}": {"isAdmin": true}, ${raw}}`);
    assert.ok(feeAddressProblems(parsed, options).length > 0, key);
  }
  assert.equal({}.isAdmin, undefined);
});
