import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Constr, Data, applyParamsToScript, validatorToScriptHash } from '@lucid-evolution/lucid';

import { encodeParams } from './apply-params.mjs';
import { validateParams } from './lib/deployment.mjs';
import {
  BLUEPRINT,
  aikenApply,
  aikenTest,
  assertBadInput,
  feeAddressFor,
  runScript,
  splitBaseAddress,
  symlinkedRepo,
  tempDirs,
  v1Params,
  writeParams,
} from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

const unapplied = JSON.parse(readFileSync(BLUEPRINT, 'utf8')).validators[0];

/** Applies the params with the real apply-params and returns the deployments folder it used. */
function deploy({ network = 'preprod', version = 1, overrides = {} } = {}) {
  const dir = dirs.make('verify-run-');
  const fee = feeAddressFor(network, version);
  writeParams(dir, network, version, v1Params(fee.address, overrides));
  const folder = join(dir, `${network}-v${version}`);
  const result = runScript('apply-params.mjs', [
    '--network', network,
    '--version', String(version),
    '--params', join(folder, 'params.json'),
    '--dir', dir,
  ]);
  assert.equal(result.status, 0, `apply-params failed:\n${result.stdout}\n${result.stderr}`);
  return { dir, folder, fee, network, version };
}

const verify = ({ dir, network, version }) =>
  runScript('verify-params.mjs', ['--network', network, '--version', String(version), '--dir', dir]);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Flips the first hex digit, so the value stays valid hex of the same length. */
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

// ---------------------------------------------------------------------------------------------

test('Lucid hashes the committed unapplied script to the hash in the blueprint (same PlutusV3 convention as Aiken)', () => {
  assert.equal(
    validatorToScriptHash({ type: 'PlutusV3', script: unapplied.compiledCode }),
    unapplied.hash,
  );
});

aikenTest('two independent implementations agree: apply-params (Aiken) then verify-params (Lucid) exits 0', () => {
  const cases = [
    { network: 'preprod', version: 1, overrides: {} },
    { network: 'preprod', version: 1, overrides: { maxFeeLovelace: null } },
    { network: 'mainnet', version: 2, overrides: {} },
    { network: 'mainnet', version: 2, overrides: { maxFeeLovelace: null, feeBps: 250, minFeeLovelace: 0 } },
    { network: 'preprod', version: 300, overrides: { feeBps: 1000, minFeeLovelace: 2 ** 32, maxFeeLovelace: 2 ** 40 } },
  ];
  for (const options of cases) {
    const run = deploy(options);
    const result = verify(run);
    const label = JSON.stringify(options);
    assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '', label);
    const { scriptHash } = readJson(join(run.folder, 'script.json'));
    assert.match(result.stdout, new RegExp(scriptHash), label);
  }
});

aikenTest('a tampered script.json hash exits 1 and prints both hashes', () => {
  const run = deploy();
  const path = join(run.folder, 'script.json');
  const script = readJson(path);
  const tampered = flip(script.scriptHash);
  writeJson(path, { ...script, scriptHash: tampered });
  const result = verify(run);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes(script.scriptHash), 're-applied hash printed');
  assert.ok(result.stdout.includes(tampered), 'script.json hash printed');
});

aikenTest('a tampered script.json compiledCode exits 1', () => {
  const run = deploy();
  const path = join(run.folder, 'script.json');
  const script = readJson(path);
  // Change a byte in the middle of the program, keeping valid hex of the same length.
  const middle = Math.floor(script.compiledCode.length / 2);
  const code = script.compiledCode.slice(0, middle) + flip(script.compiledCode.slice(middle));
  writeJson(path, { ...script, compiledCode: code });
  const result = verify(run);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
});

aikenTest('changing params.json after applying makes verify exit 1', () => {
  for (const change of [
    { feeBps: 101 },
    { minFeeLovelace: 1_500_001 },
    { maxFeeLovelace: null },
    { maxFeeLovelace: 5_000_001 },
  ]) {
    const run = deploy();
    const path = join(run.folder, 'params.json');
    writeJson(path, { ...readJson(path), ...change });
    const result = verify(run);
    assert.equal(result.status, 1, `${JSON.stringify(change)}\n${result.stdout}\n${result.stderr}`);
  }
});

aikenTest('a plutus.json that does not match script.json exits 1', () => {
  const run = deploy();
  const other = deploy({ overrides: { feeBps: 101 } });
  copyFileSync(join(other.folder, 'plutus.json'), join(run.folder, 'plutus.json'));
  const result = verify(run);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
});

aikenTest('catches the parameter encoding mistakes that still give a valid script', () => {
  const fee = feeAddressFor('preprod', 1);
  const { paymentHash, stakeHash } = splitBaseAddress(fee.address);
  const params = v1Params(fee.address);
  const right = encodeParams(validateParams(params, 'preprod'));
  const order = ['fee_address', 'fee_bps', 'min_fee', 'max_fee'];
  const hex = (data) => Data.to(data);
  const address = (payment, stake) => hex(new Constr(0, [payment, stake]));
  const script = (hash) => new Constr(1, [hash]);
  const key = (hash) => new Constr(0, [hash]);
  const someInline = (credential) => new Constr(0, [new Constr(0, [credential])]);

  // Each mistake, and whether `aiken blueprint apply` already refuses it. Aiken checks a
  // parameter's shape against the blueprint schema, which stops the integer where an Option goes,
  // but both a pointer and an inline credential are valid stake parts, so those get through.
  const mistakes = [
    ['max_fee as a bare integer', { ...right, max_fee: hex(5_000_000n) }, true],
    ['max_fee as Some with no value', { ...right, max_fee: hex(new Constr(0, [])) }, true],
    ['max_fee as None while the params say Some', { ...right, max_fee: hex(new Constr(1, [])) }, false],
    [
      'the stake part as a pointer',
      { ...right, fee_address: address(script(paymentHash), new Constr(0, [new Constr(1, [1n, 2n, 3n])])) },
      false,
    ],
    ['the payment part as a key hash', { ...right, fee_address: address(key(paymentHash), someInline(key(stakeHash))) }, false],
    ['the stake part as a script hash', { ...right, fee_address: address(script(paymentHash), someInline(script(stakeHash))) }, false],
    ['no stake part', { ...right, fee_address: address(script(paymentHash), new Constr(1, [])) }, false],
    ['fee_bps and min_fee swapped', { ...right, fee_bps: right.min_fee, min_fee: right.fee_bps }, false],
  ];

  /** A deployment folder holding the given script, as an operator who skipped the check would leave it. */
  const folderFor = ({ scriptHash, compiledCode, blueprintPath }) => {
    const dir = dirs.make('verify-mistake-');
    const folder = join(dir, 'preprod-v1');
    writeParams(dir, 'preprod', 1, params);
    writeJson(join(folder, 'script.json'), { scriptHash, compiledCode });
    copyFileSync(blueprintPath, join(folder, 'plutus.json'));
    return { dir, network: 'preprod', version: 1 };
  };

  // The control: the real encoding, applied the same way, passes.
  const control = aikenApply(order.map((name) => right[name]), dirs.make('verify-mistake-'));
  assert.equal(control.rejected, undefined, control.rejected);
  const passed = verify(folderFor(control));
  assert.equal(passed.status, 0, `control\n${passed.stdout}\n${passed.stderr}`);

  for (const [label, parameters, aikenRefuses] of mistakes) {
    const built = aikenApply(order.map((name) => parameters[name]), dirs.make('verify-mistake-'));
    assert.equal(built.rejected !== undefined, aikenRefuses, `${label}: aiken ${aikenRefuses ? 'refuses' : 'accepts'} it`);
    // Where Aiken refuses, build the script the way Lucid Evolution would (no schema check).
    const deployment = built.rejected === undefined ? built : lucidBuild(parameters, order);
    const result = verify(folderFor(deployment));
    assert.equal(result.status, 1, `${label} must be caught\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '', label);
  }
});

/** The unapplied script with the given CBOR parameters applied by Lucid Evolution, with no shape check. */
function lucidBuild(parameters, order) {
  const compiledCode = applyParamsToScript(unapplied.compiledCode, order.map((name) => Data.from(parameters[name])));
  return { scriptHash: validatorToScriptHash({ type: 'PlutusV3', script: compiledCode }), compiledCode, blueprintPath: BLUEPRINT };
}

test('a script.json hash that does not match exits 1 and prints both hashes (no Aiken needed)', () => {
  const dir = dirs.make('verify-static-');
  const fee = feeAddressFor('preprod', 1);
  const folder = join(dir, 'preprod-v1');
  writeParams(dir, 'preprod', 1, v1Params(fee.address));
  const fake = '00'.repeat(28);
  writeJson(join(folder, 'script.json'), { scriptHash: fake, compiledCode: unapplied.compiledCode });
  copyFileSync(BLUEPRINT, join(folder, 'plutus.json'));
  const result = runScript('verify-params.mjs', ['--network=preprod', '--version=1', `--dir=${dir}`]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(fake), 'script.json hash printed');
  const printed = result.stdout.match(/\b[0-9a-f]{56}\b/g);
  assert.ok(new Set(printed).size >= 2, 'the re-applied hash is printed as well');
});

test('started through a symlink to the repo, a tampered script.json still exits 1 (it must not exit 0 unchecked)', () => {
  const repo = symlinkedRepo(dirs.make('verify-link-'));
  const dir = dirs.make('verify-static-');
  const fee = feeAddressFor('preprod', 1);
  const folder = join(dir, 'preprod-v1');
  writeParams(dir, 'preprod', 1, v1Params(fee.address));
  const fake = '00'.repeat(28);
  writeJson(join(folder, 'script.json'), { scriptHash: fake, compiledCode: unapplied.compiledCode });
  copyFileSync(BLUEPRINT, join(folder, 'plutus.json'));
  const result = runScript('verify-params.mjs', ['--network=preprod', '--version=1', `--dir=${dir}`], { repo });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(fake), 'both hashes are printed');
  // And a missing deployment is still bad input, not a silent success.
  const missing = runScript('verify-params.mjs', ['--network=preprod', '--version=2', `--dir=${dir}`], { repo });
  assertBadInput(missing, /preprod-v2/, 'missing folder through a symlink');
});

test('bad input exits 2: missing files, unreadable JSON, unknown network, bad version, unknown option', () => {
  const dir = dirs.make('verify-bad-');
  const base = ['--network=preprod', '--version=1', `--dir=${dir}`];
  assertBadInput(runScript('verify-params.mjs', base), /params\.json|preprod-v1/, 'no deployment folder');

  const fee = feeAddressFor('preprod', 1);
  const folder = join(dir, 'preprod-v1');
  writeParams(dir, 'preprod', 1, v1Params(fee.address));
  assertBadInput(runScript('verify-params.mjs', base), /script\.json/, 'no script.json');

  writeFileSync(join(folder, 'script.json'), '{ not json');
  assertBadInput(runScript('verify-params.mjs', base), /script\.json/, 'script.json not JSON');

  writeJson(join(folder, 'script.json'), { scriptHash: 'xyz', compiledCode: 'zz' });
  assertBadInput(runScript('verify-params.mjs', base), /script\.json/, 'script.json malformed');

  writeJson(join(folder, 'script.json'), { scriptHash: '00'.repeat(28), compiledCode: unapplied.compiledCode });
  assertBadInput(runScript('verify-params.mjs', base), /plutus\.json/, 'no plutus.json');

  copyFileSync(BLUEPRINT, join(folder, 'plutus.json'));
  writeFileSync(join(folder, 'params.json'), JSON.stringify({ ...v1Params(fee.address), feeBps: 0 }));
  assertBadInput(runScript('verify-params.mjs', base), /feeBps/, 'params fail the same checks as apply-params');

  assertBadInput(runScript('verify-params.mjs', ['--network=devnet', '--version=1', `--dir=${dir}`]), /network/, 'network');
  assertBadInput(runScript('verify-params.mjs', ['--network=preprod', '--version=0', `--dir=${dir}`]), /version/, 'version');
  assertBadInput(runScript('verify-params.mjs', ['--version=1', `--dir=${dir}`]), /network/, 'no network');
  assertBadInput(runScript('verify-params.mjs', [...base, '--bogus=1']), /bogus/, 'unknown option');
});
