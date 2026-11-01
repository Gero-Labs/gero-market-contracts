import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Constr, Data } from '@lucid-evolution/lucid';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { encodeParams } from './apply-params.mjs';
import { UsageError, deploymentPaths, parseNetwork, parseVersion, validateParams } from './lib/deployment.mjs';
import {
  BLUEPRINT,
  aikenTest,
  assertBadInput,
  baseAddress,
  bech32Encode,
  feeAddressFor,
  madeUpKeyHash,
  parseJsonOutput,
  pointerAddress,
  runScript,
  splitBaseAddress,
  symlinkedRepo,
  tempDirs,
  v1Params,
  writeParams,
} from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

const PREPROD_FEE = feeAddressFor('preprod', 1);
const MAINNET_FEE = feeAddressFor('mainnet', 1);
const { paymentHash: SCRIPT_HASH, stakeHash: STAKE_HASH } = splitBaseAddress(PREPROD_FEE.address);

/** Plutus data as plain objects, so comparisons do not depend on class identity. */
function plain(data) {
  if (data instanceof Constr) return { constr: data.index, fields: data.fields.map(plain) };
  if (typeof data === 'bigint') return { int: data.toString() };
  if (typeof data === 'string') return { bytes: data };
  throw new Error(`unexpected Plutus data: ${String(data)}`);
}

/** Decodes CBOR with Lucid's decoder, not with the encoder under test. */
const decode = (cbor) => plain(Data.from(cbor));

const constr = (constr, ...fields) => ({ constr, fields });
const bytes = (value) => ({ bytes: value });
const int = (value) => ({ int: String(value) });

const encoded = (params, network = 'preprod') => encodeParams(validateParams(params, network));

// ---------------------------------------------------------------------------------------------
// Encoding

test('fee_address is Constr 0 [Constr 1 [B script hash], Constr 0 [Constr 0 [Constr 0 [B stake key hash]]]]', () => {
  const { fee_address: cbor } = encoded(v1Params(PREPROD_FEE.address));
  assert.deepEqual(
    decode(cbor),
    constr(
      0,
      constr(1, bytes(SCRIPT_HASH)), // payment part: Script
      constr(0, constr(0, constr(0, bytes(STAKE_HASH)))), // stake part: Some(Inline(VerificationKey))
    ),
  );
  assert.equal(SCRIPT_HASH, PREPROD_FEE.scriptHash);
  assert.equal(STAKE_HASH, madeUpKeyHash('stake'));
  assert.equal(cbor, `d8799fd87a9f581c${SCRIPT_HASH}ffd8799fd8799fd8799f581c${STAKE_HASH}ffffffff`);
});

test('the integers are plain integers', () => {
  const params = encoded(v1Params(PREPROD_FEE.address));
  assert.equal(params.fee_bps, '1864');
  assert.equal(params.min_fee, '1a0016e360');
  assert.deepEqual(decode(params.fee_bps), int(100));
  assert.deepEqual(decode(params.min_fee), int(1_500_000));
});

test('max_fee is Constr 0 [I n] for Some and Constr 1 [] for None, never a bare integer', () => {
  const some = encoded(v1Params(PREPROD_FEE.address)).max_fee;
  assert.equal(some, 'd8799f1a004c4b40ff');
  assert.deepEqual(decode(some), constr(0, int(5_000_000)));
  const none = encoded(v1Params(PREPROD_FEE.address, { maxFeeLovelace: null })).max_fee;
  assert.equal(none, 'd87a80');
  assert.deepEqual(decode(none), constr(1));
});

test('the parameters come out in declaration order, one CBOR each', () => {
  const params = encoded(v1Params(PREPROD_FEE.address));
  assert.deepEqual(Object.keys(params), ['fee_address', 'fee_bps', 'min_fee', 'max_fee']);
  for (const cbor of Object.values(params)) assert.match(cbor, /^(?:[0-9a-f]{2})+$/);
});

test('integers encode correctly at every CBOR width boundary', () => {
  const values = [0, 1, 23, 24, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER];
  for (const value of values) {
    const params = encoded(v1Params(PREPROD_FEE.address, { minFeeLovelace: value, maxFeeLovelace: null }));
    assert.deepEqual(decode(params.min_fee), int(value), `min_fee ${value}`);
    const withCap = encoded(v1Params(PREPROD_FEE.address, { minFeeLovelace: 0, maxFeeLovelace: value }));
    assert.deepEqual(decode(withCap.max_fee), constr(0, int(value)), `max_fee ${value}`);
  }
  // Shortest forms, written out by hand.
  const shortest = (value) =>
    encoded(v1Params(PREPROD_FEE.address, { minFeeLovelace: value, maxFeeLovelace: null })).min_fee;
  assert.equal(shortest(23), '17');
  assert.equal(shortest(24), '1818');
  assert.equal(shortest(256), '190100');
  assert.equal(shortest(65536), '1a00010000');
  assert.equal(shortest(2 ** 32), '1b0000000100000000');
});

test('the constructor indices used match the committed blueprint schema', () => {
  const { definitions } = JSON.parse(readFileSync(BLUEPRINT, 'utf8'));
  const indexOf = (definition, title) => definitions[definition].anyOf.find((c) => c.title === title).index;
  assert.equal(indexOf('cardano/address/Address', 'Address'), 0);
  assert.equal(indexOf('cardano/address/PaymentCredential', 'Script'), 1);
  assert.equal(indexOf('cardano/address/PaymentCredential', 'VerificationKey'), 0);
  assert.equal(indexOf('Option<cardano/address/StakeCredential>', 'Some'), 0);
  assert.equal(indexOf('cardano/address/StakeCredential', 'Inline'), 0);
  assert.equal(indexOf('cardano/address/Credential', 'VerificationKey'), 0);
  assert.equal(indexOf('Option<Int>', 'Some'), 0);
  assert.equal(indexOf('Option<Int>', 'None'), 1);
  const [validator] = JSON.parse(readFileSync(BLUEPRINT, 'utf8')).validators;
  assert.deepEqual(
    validator.parameters.map((p) => p.title),
    ['fee_address', 'fee_bps', 'min_fee', 'max_fee'],
  );
});

// ---------------------------------------------------------------------------------------------
// Input checks (no Aiken needed: they fail before it is called)

const enterprise = (hash, network = 'preprod') =>
  bech32Encode(network === 'mainnet' ? 'addr' : 'addr_test', Uint8Array.from([0x70 | (network === 'mainnet' ? 1 : 0), ...hexToBytes(hash)]));
const rewardAddress = (hash) => bech32Encode('stake_test', Uint8Array.from([0xe0, ...hexToBytes(hash)]));

function applyParams({ params, raw, network = 'preprod', version = 1, extra = [] }) {
  const input = dirs.make('apply-input-');
  const out = dirs.make('apply-out-');
  const path = join(input, 'params.json');
  writeFileSync(path, raw ?? JSON.stringify(params));
  const result = runScript('apply-params.mjs', [
    `--network=${network}`,
    `--version=${version}`,
    `--params=${path}`,
    `--dir=${out}`,
    ...extra,
  ]);
  return { ...result, out };
}

const BAD_PARAMS = () => {
  const good = v1Params(PREPROD_FEE.address);
  const sig = splitBaseAddress(PREPROD_FEE.address);
  const without = (key) => (({ [key]: _, ...rest }) => rest)(good);
  return [
    // fee_bps: 0 < fee_bps < 10000 on chain, and at most 1000 by the deployment review
    ['feeBps 0', { ...good, feeBps: 0 }, /feeBps/],
    ['feeBps negative', { ...good, feeBps: -1 }, /feeBps/],
    ['feeBps 10000', { ...good, feeBps: 10000 }, /feeBps/],
    ['feeBps 10001', { ...good, feeBps: 10001 }, /feeBps/],
    ['feeBps 1001 (review rule)', { ...good, feeBps: 1001 }, /feeBps.*1000/],
    ['feeBps fractional', { ...good, feeBps: 100.5 }, /feeBps/],
    ['feeBps as a string', { ...good, feeBps: '100' }, /feeBps/],
    ['feeBps null', { ...good, feeBps: null }, /feeBps/],
    // min_fee
    ['minFeeLovelace negative', { ...good, minFeeLovelace: -1 }, /minFeeLovelace/],
    ['minFeeLovelace fractional', { ...good, minFeeLovelace: 1.5 }, /minFeeLovelace/],
    ['minFeeLovelace as a string', { ...good, minFeeLovelace: '1500000' }, /minFeeLovelace/],
    ['minFeeLovelace past the safe integers', { ...good, minFeeLovelace: 2 ** 53, maxFeeLovelace: null }, /minFeeLovelace/],
    // max_fee: null or an integer of at least min_fee
    ['maxFeeLovelace below minFeeLovelace', { ...good, maxFeeLovelace: 1_499_999 }, /maxFeeLovelace/],
    ['maxFeeLovelace as a string', { ...good, maxFeeLovelace: '5000000' }, /maxFeeLovelace/],
    ['maxFeeLovelace fractional', { ...good, maxFeeLovelace: 5_000_000.5 }, /maxFeeLovelace/],
    ['maxFeeLovelace left out (null must be explicit)', without('maxFeeLovelace'), /maxFeeLovelace/],
    ['an unknown field', { ...good, waiverKey: madeUpKeyHash('waiver') }, /waiverKey/],
    // fee_address: a base address, script payment part, key stake part, on the right network
    ['feeAddress left out', without('feeAddress'), /feeAddress/],
    ['feeAddress that is not a string', { ...good, feeAddress: 42 }, /feeAddress/],
    ['feeAddress that is not an address', { ...good, feeAddress: 'addr_test1notanaddress' }, /feeAddress/],
    [
      'feeAddress with key payment and key stake parts',
      { ...good, feeAddress: baseAddress({ network: 'preprod', type: 0, paymentHash: sig.paymentHash, stakeHash: sig.stakeHash }) },
      /feeAddress.*script/i,
    ],
    [
      'feeAddress with a script stake part',
      { ...good, feeAddress: baseAddress({ network: 'preprod', type: 3, paymentHash: sig.paymentHash, stakeHash: sig.stakeHash }) },
      /feeAddress.*stake/i,
    ],
    ['feeAddress with no stake part', { ...good, feeAddress: enterprise(sig.paymentHash) }, /feeAddress.*base/i],
    [
      'feeAddress whose stake part is a pointer',
      { ...good, feeAddress: pointerAddress({ network: 'preprod', paymentHash: sig.paymentHash }) },
      /feeAddress.*base/i,
    ],
    ['feeAddress that is a reward address', { ...good, feeAddress: rewardAddress(sig.stakeHash) }, /feeAddress.*base/i],
    ['feeAddress of the other network', { ...good, feeAddress: MAINNET_FEE.address }, /feeAddress.*network/i],
    [
      'feeAddress as hex bytes',
      { ...good, feeAddress: bytesToHex(Uint8Array.from([0x10, ...hexToBytes(sig.paymentHash), ...hexToBytes(sig.stakeHash)])) },
      /feeAddress/,
    ],
  ];
};

test('bad parameters are refused, and the message names the field', () => {
  for (const [label, params, pattern] of BAD_PARAMS()) {
    assert.throws(() => validateParams(params, 'preprod'), (error) => error instanceof UsageError && pattern.test(error.message), label);
  }
});

test('bad parameters on the command line exit 2 and write nothing', () => {
  // A few of the cases above through the real script: the exit code and the empty output folder.
  const wanted = ['feeBps 1001 (review rule)', 'maxFeeLovelace left out (null must be explicit)', 'feeAddress whose stake part is a pointer', 'feeAddress of the other network'];
  for (const [label, params, pattern] of BAD_PARAMS().filter(([name]) => wanted.includes(name))) {
    const result = applyParams({ params });
    assertBadInput(result, pattern, label);
    assert.deepEqual(readdirSync(result.out), [], `${label}: nothing written`);
  }
});

test('a mainnet fee address is refused for preprod and accepted for mainnet in validation', () => {
  assert.throws(() => validateParams(v1Params(MAINNET_FEE.address), 'preprod'), /network/);
  assert.throws(() => validateParams(v1Params(PREPROD_FEE.address), 'mainnet'), /network/);
  assert.doesNotThrow(() => validateParams(v1Params(MAINNET_FEE.address), 'mainnet'));
});

test('the limits themselves are accepted: feeBps 1 and 1000, equal min and max, min 0', () => {
  for (const overrides of [
    { feeBps: 1 },
    { feeBps: 1000 },
    { minFeeLovelace: 2_000_000, maxFeeLovelace: 2_000_000 },
    { minFeeLovelace: 0, maxFeeLovelace: 0 },
    { maxFeeLovelace: null },
  ]) {
    assert.doesNotThrow(() => validateParams(v1Params(PREPROD_FEE.address, overrides), 'preprod'), JSON.stringify(overrides));
  }
});

test('a network or version that could point outside the deployments folder is refused', () => {
  for (const network of ['../preprod', 'preprod/../mainnet', '/etc', 'constructor', '__proto__', 'toString', 'Preprod', '', ' preprod']) {
    assert.throws(() => parseNetwork(network), (error) => error instanceof UsageError && /network/.test(error.message), JSON.stringify(network));
  }
  for (const version of ['../1', '1/../../x', '1/2', '1\\2', '-1', '0', '01', '1.5', '1e3', '0x10', ' 1', '1 ', '1\n', '1000001', '', 'NaN']) {
    assert.throws(() => parseVersion(version), (error) => error instanceof UsageError && /version/.test(error.message), JSON.stringify(version));
  }
  assert.equal(parseNetwork('preprod'), 'preprod');
  assert.equal(parseVersion('1000000'), 1_000_000);
  const base = dirs.make('deployments-base-');
  assert.equal(deploymentPaths(base, 'mainnet', 7).folder, join(base, 'mainnet-v7'));
});

test('prototype keys in params.json are refused as unknown fields and pollute nothing', () => {
  const good = JSON.stringify(v1Params(PREPROD_FEE.address)).slice(1, -1);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = `{"${key}": {"isAdmin": true}, ${good}}`;
    assert.throws(
      () => validateParams(JSON.parse(raw), 'preprod'),
      (error) => error instanceof UsageError && error.message.includes(key),
      key,
    );
  }
  assert.equal({}.isAdmin, undefined);
  assertBadInput(applyParams({ raw: `{"__proto__": {"isAdmin": true}, ${good}}` }), /__proto__/, 'through the script');
});

test('a params file that is not an object, not JSON or missing exits 2', () => {
  assertBadInput(applyParams({ raw: '[]' }), /params/i, 'array');
  assertBadInput(applyParams({ raw: 'null' }), /params/i, 'null');
  assertBadInput(applyParams({ raw: '{ not json' }), /params/i, 'not JSON');
  const out = dirs.make('apply-out-');
  assertBadInput(
    runScript('apply-params.mjs', ['--network=preprod', '--version=1', `--params=${join(out, 'nope.json')}`, `--dir=${out}`]),
    /params/i,
    'missing file',
  );
});

test('started through a symlink to the repo it still runs: bad parameters exit 2, nothing is written', () => {
  const repo = symlinkedRepo(dirs.make('apply-link-'));
  const input = dirs.make('apply-input-');
  const out = dirs.make('apply-out-');
  const params = join(input, 'params.json');
  writeFileSync(params, JSON.stringify(v1Params(PREPROD_FEE.address, { feeBps: 1001 })));
  const result = runScript(
    'apply-params.mjs',
    ['--network=preprod', '--version=1', `--params=${params}`, `--dir=${out}`],
    { repo },
  );
  assertBadInput(result, /feeBps/, 'through a symlink');
  assert.deepEqual(readdirSync(out), []);
});

test('bad command lines exit 2', () => {
  const dir = dirs.make('apply-cli-');
  const params = writeParams(dir, 'preprod', 1, v1Params(PREPROD_FEE.address));
  const full = [`--network=preprod`, `--version=1`, `--params=${params}`, `--dir=${dir}`];
  assertBadInput(runScript('apply-params.mjs', full.filter((a) => !a.startsWith('--network'))), /network/, 'no network');
  assertBadInput(runScript('apply-params.mjs', full.filter((a) => !a.startsWith('--version'))), /version/, 'no version');
  assertBadInput(runScript('apply-params.mjs', full.filter((a) => !a.startsWith('--params'))), /params/, 'no params');
  assertBadInput(runScript('apply-params.mjs', [...full.slice(1), '--network=devnet']), /network/, 'unknown network');
  assertBadInput(runScript('apply-params.mjs', [...full.slice(0, 1), '--version=0', ...full.slice(2)]), /version/, 'version 0');
  assertBadInput(runScript('apply-params.mjs', [...full, '--bogus=1']), /bogus/, 'unknown option');
  assert.equal(existsSync(join(dir, 'preprod-v1', 'plutus.json')), false);
});

test('an Aiken that is not v1.1.24, or none at all, exits 2 and writes nothing', () => {
  const bin = dirs.make('fake-aiken-');
  const input = dirs.make('apply-input-');
  const out = dirs.make('apply-out-');
  const params = join(input, 'params.json');
  writeFileSync(params, JSON.stringify(v1Params(PREPROD_FEE.address)));
  const args = ['--network=preprod', '--version=1', `--params=${params}`, `--dir=${out}`];

  const missing = runScript('apply-params.mjs', args, { env: { ...process.env, PATH: bin } });
  assertBadInput(missing, /aiken/i, 'no aiken on PATH');

  const fake = join(bin, 'aiken');
  writeFileSync(fake, '#!/bin/sh\necho "aiken v1.1.16+deadbee"\n');
  chmodSync(fake, 0o755);
  const wrong = runScript('apply-params.mjs', args, { env: { ...process.env, PATH: bin } });
  assertBadInput(wrong, /v1\.1\.24/, 'wrong aiken version');
  assert.deepEqual(readdirSync(out), []);
});

// ---------------------------------------------------------------------------------------------
// Applying for real

const NET = 'preprod';

/** Runs apply-params for the sample fee address and returns the summary and the output folder. */
function applied(overrides = {}, { network = NET, version = 1, feeAddress = PREPROD_FEE.address } = {}) {
  const dir = dirs.make('apply-run-');
  const params = writeParams(dir, network, version, v1Params(feeAddress, overrides));
  const result = runScript('apply-params.mjs', [
    '--network', network,
    '--version', String(version),
    '--params', params,
    '--dir', dir,
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const folder = join(dir, `${network}-v${version}`);
  return {
    dir,
    folder,
    summary: parseJsonOutput(result),
    script: JSON.parse(readFileSync(join(folder, 'script.json'), 'utf8')),
  };
}

aikenTest('maxFeeLovelace null and 5000000 give different script hashes', () => {
  const some = applied({ maxFeeLovelace: 5_000_000 });
  const none = applied({ maxFeeLovelace: null });
  assert.match(some.script.scriptHash, /^[0-9a-f]{56}$/);
  assert.match(none.script.scriptHash, /^[0-9a-f]{56}$/);
  assert.notEqual(some.script.scriptHash, none.script.scriptHash);
});

aikenTest('the parameters printed (the ones passed to aiken) decode to the expected data', () => {
  const run = applied();
  const { parameters } = run.summary;
  assert.deepEqual(Object.keys(parameters), ['fee_address', 'fee_bps', 'min_fee', 'max_fee']);
  assert.deepEqual(
    decode(parameters.fee_address),
    constr(0, constr(1, bytes(SCRIPT_HASH)), constr(0, constr(0, constr(0, bytes(STAKE_HASH))))),
  );
  assert.deepEqual(decode(parameters.fee_bps), int(100));
  assert.deepEqual(decode(parameters.min_fee), int(1_500_000));
  assert.deepEqual(decode(parameters.max_fee), constr(0, int(5_000_000)));
  assert.equal(run.summary.scriptHash, run.script.scriptHash);
});

aikenTest('writes an applied plutus.json and a script.json whose hash is the applied validator hash', () => {
  const run = applied();
  assert.deepEqual(Object.keys(run.script).sort(), ['compiledCode', 'scriptHash']);

  const unapplied = JSON.parse(readFileSync(BLUEPRINT, 'utf8'));
  const blueprint = JSON.parse(readFileSync(join(run.folder, 'plutus.json'), 'utf8'));
  assert.deepEqual(blueprint.preamble, unapplied.preamble);
  assert.deepEqual(blueprint.definitions, unapplied.definitions);
  for (const validator of blueprint.validators) {
    assert.equal(validator.parameters, undefined, `${validator.title} has no parameters left`);
    assert.equal(validator.hash, run.script.scriptHash, validator.title);
  }
  const spend = blueprint.validators.find((v) => v.title === 'listing.listing.spend');
  assert.equal(spend.compiledCode, run.script.compiledCode);
  assert.notEqual(run.script.compiledCode, unapplied.validators[0].compiledCode);
  assert.notEqual(run.script.scriptHash, unapplied.validators[0].hash);

  // Aiken's own hash command agrees with the file it wrote.
  const hash = spawnSync(
    'aiken',
    ['blueprint', 'hash', '--in', join(run.folder, 'plutus.json'), '--module', 'listing', '--validator', 'listing'],
    { encoding: 'utf8' },
  );
  assert.equal(hash.stdout.trim(), run.script.scriptHash);
});

aikenTest('leaves the committed plutus.json alone and is repeatable byte for byte', () => {
  const before = readFileSync(BLUEPRINT);
  const first = applied();
  const second = applied();
  assert.deepEqual(readFileSync(BLUEPRINT), before);
  for (const file of ['plutus.json', 'script.json']) {
    assert.deepEqual(readFileSync(join(first.folder, file)), readFileSync(join(second.folder, file)), file);
  }
});

aikenTest('each parameter changes the script hash', () => {
  const base = applied().script.scriptHash;
  const variants = {
    feeBps: applied({ feeBps: 101 }),
    minFeeLovelace: applied({ minFeeLovelace: 1_500_001 }),
    maxFeeLovelace: applied({ maxFeeLovelace: 5_000_001 }),
    feeAddress: applied({}, { version: 2, feeAddress: feeAddressFor('preprod', 2).address }),
  };
  const hashes = [base, ...Object.values(variants).map((v) => v.script.scriptHash)];
  assert.equal(new Set(hashes).size, hashes.length, JSON.stringify(Object.keys(variants)));
});

aikenTest('keeps a copy of the params next to the result when they came from elsewhere', () => {
  const input = dirs.make('apply-input-');
  const out = dirs.make('apply-out-');
  const params = join(input, 'my-params.json');
  writeFileSync(params, `${JSON.stringify(v1Params(PREPROD_FEE.address))}\n`);
  const result = runScript('apply-params.mjs', ['--network=preprod', '--version=3', `--params=${params}`, `--dir=${out}`]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(
    readFileSync(join(out, 'preprod-v3', 'params.json')),
    readFileSync(params),
  );
  assert.deepEqual(readdirSync(join(out, 'preprod-v3')).sort(), ['params.json', 'plutus.json', 'script.json']);
});

aikenTest('params already inside the deployment folder are used in place', () => {
  const dir = dirs.make('apply-run-');
  const params = writeParams(dir, 'mainnet', 2, v1Params(MAINNET_FEE.address));
  const original = readFileSync(params);
  const result = runScript('apply-params.mjs', ['--network=mainnet', '--version=2', `--params=${params}`, `--dir=${dir}`]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readFileSync(params), original);
  assert.deepEqual(readdirSync(join(dir, 'mainnet-v2')).sort(), ['params.json', 'plutus.json', 'script.json']);
});
