import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  EXPECTED,
  contextProblems,
  decodeData,
  pinnedHex,
  toUplcData,
} from './eval-applied.mjs';
import { ROOT, aikenTest, assertBadInput, baseAddress, madeUpKeyHash, runScript, tempDirs } from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

const REAL_CONTEXTS = join(ROOT, 'test-vectors', 'contexts');
const REAL_TESTS = join(ROOT, 'lib', 'gero_market', 'contexts.test.ak');
const PREPROD_V1 = join(ROOT, 'deployments', 'preprod-v1');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const contextHex = (name) => readFileSync(join(REAL_CONTEXTS, 'preprod-v1', `${name}.hex`), 'utf8').trim();

/** Flips the first hex digit, so the value stays valid hex of the same length. */
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const uplc = (hex) => toUplcData(decodeData(fromHex(hex)));

/**
 * A copy of the committed preprod-v1 deployment, its contexts and the pin tests in a temporary
 * folder, renamed to `name` when asked. Returns the paths to pass to the script.
 */
function copyOfPreprodV1({ name = 'preprod-v1' } = {}) {
  const root = dirs.make('eval-applied-');
  const deployments = join(root, 'deployments');
  const folder = join(deployments, name);
  mkdirSync(folder, { recursive: true });
  for (const file of ['fee-address.json', 'params.json', 'script.json']) {
    copyFileSync(join(PREPROD_V1, file), join(folder, file));
  }
  const contexts = join(root, 'contexts');
  const contextFolder = join(contexts, name);
  mkdirSync(contextFolder, { recursive: true });
  for (const file of readdirSync(join(REAL_CONTEXTS, 'preprod-v1'))) {
    copyFileSync(join(REAL_CONTEXTS, 'preprod-v1', file), join(contextFolder, file));
  }
  const tests = join(root, 'contexts.test.ak');
  const prefix = name.replace('-', '_');
  writeFileSync(tests, readFileSync(REAL_TESTS, 'utf8').replaceAll('test preprod_v1_', `test ${prefix}_`));
  return { root, deployments, folder, contexts, contextFolder, tests };
}

const evaluate = ({ deployments, contexts, tests }, options = {}) =>
  runScript('eval-applied.mjs', ['--dir', deployments, '--contexts', contexts, '--tests', tests], options);

/** A detected mismatch: exit 1 and the finding on stdout. */
function assertMismatch(result, pattern) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, pattern);
}

// ---------------------------------------------------------------------------------------------
// CBOR to Plutus data, written without a library

test('decodes the CBOR forms Plutus data uses and prints them as UPLC data', () => {
  const cases = [
    // An output reference, as the tag vectors pin it: indefinite-length constructor 0.
    [
      'd8799f58206d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e00ff',
      'Constr 0 [B #6d2a1f9c3b8e4f0a5c7d9e1b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e, I 0]',
    ],
    ['d87980', 'Constr 0 []'],
    ['d87a80', 'Constr 1 []'],
    ['d9050080', 'Constr 7 []'],
    ['d90578820102', 'Constr 127 [I 1, I 2]'],
    ['d8668218c880', 'Constr 200 []'],
    ['820102', 'List [I 1, I 2]'],
    ['9f0102ff', 'List [I 1, I 2]'],
    ['80', 'List []'],
    ['a10141ff', 'Map [(I 1, B #ff)]'],
    ['bf0141ffff', 'Map [(I 1, B #ff)]'],
    ['a0', 'Map []'],
    ['00', 'I 0'],
    ['17', 'I 23'],
    ['1818', 'I 24'],
    ['20', 'I -1'],
    ['3903e7', 'I -1000'],
    ['1bffffffffffffffff', 'I 18446744073709551615'],
    ['3bffffffffffffffff', 'I -18446744073709551616'],
    ['c249010000000000000000', 'I 18446744073709551616'],
    ['c349010000000000000000', 'I -18446744073709551617'],
    ['40', 'B #'],
    ['5f41aa41bbff', 'B #aabb'],
  ];
  for (const [hex, text] of cases) assert.equal(uplc(hex), text, hex);
});

test('refuses CBOR that is not Plutus data: trailing bytes, a cut-off item, floats, text, other tags', () => {
  for (const hex of ['0000', '5820aa', '82', 'f93c00', '6161', 'd82a00', 'd87a', 'ff']) {
    assert.throws(() => decodeData(fromHex(hex)), Error, hex);
  }
});

test('every committed context decodes to a script context of the spending kind', () => {
  for (const name of Object.keys(EXPECTED)) {
    const text = uplc(contextHex(name));
    assert.match(text, /^Constr 0 \[/, name);
  }
});

// ---------------------------------------------------------------------------------------------
// Pins and the tie to a deployment

test('finds the bytes a test pins, and only in that test and outside comments', () => {
  const source = [
    'test preprod_v1_purchase_ok() {',
    '  cbor.serialise(x) == #"d87980"',
    '}',
    '',
    '// test preprod_v1_cancel_ok() { cbor.serialise(y) == #"d87a80" }',
    'test preprod_v1_purchase_fee_short() {',
    '  // #"ffff"',
    '  cbor.serialise(z) == #"d87b80"',
    '}',
  ].join('\n');
  assert.equal(pinnedHex(source, 'preprod_v1_purchase_ok'), 'd87980');
  assert.equal(pinnedHex(source, 'preprod_v1_purchase_fee_short'), 'd87b80');
  assert.equal(pinnedHex(source, 'preprod_v1_cancel_ok'), undefined);
  assert.equal(pinnedHex(source, 'preprod_v1_purchase'), undefined);
});

test('the committed pin tests hold the bytes of the committed context files', () => {
  const source = readFileSync(REAL_TESTS, 'utf8');
  for (const name of Object.keys(EXPECTED)) {
    assert.equal(pinnedHex(source, `preprod_v1_${name}`), contextHex(name), name);
  }
});

test('a committed context is tied to preprod-v1: its listing is at that script, its fee goes to that fee address', () => {
  const { scriptHash } = readJson(join(PREPROD_V1, 'script.json'));
  const { feeAddress } = readJson(join(PREPROD_V1, 'params.json'));
  const deployment = { scriptHash, feeAddress };
  for (const name of Object.keys(EXPECTED)) {
    assert.deepEqual(contextProblems(name, decodeData(fromHex(contextHex(name))), deployment), [], name);
  }
  const other = { scriptHash: flip(scriptHash), feeAddress };
  assert.match(contextProblems('cancel_ok', decodeData(fromHex(contextHex('cancel_ok'))), other).join('\n'), /script hash/);
  const elsewhere = {
    scriptHash,
    feeAddress: baseAddress({ network: 'preprod', type: 1, paymentHash: madeUpKeyHash('fee'), stakeHash: madeUpKeyHash('stake') }),
  };
  assert.match(
    contextProblems('purchase_ok', decodeData(fromHex(contextHex('purchase_ok'))), elsewhere).join('\n'),
    /fee address/,
  );
  assert.deepEqual(contextProblems('cancel_ok', decodeData(fromHex(contextHex('cancel_ok'))), elsewhere), []);
});

// ---------------------------------------------------------------------------------------------
// What the script refuses before it evaluates anything (no Aiken needed)

test('a deployment with no contexts folder exits 1 and names it', () => {
  const copy = copyOfPreprodV1();
  mkdirSync(join(copy.deployments, 'preprod-v2'));
  copyFileSync(join(copy.folder, 'script.json'), join(copy.deployments, 'preprod-v2', 'script.json'));
  copyFileSync(join(copy.folder, 'params.json'), join(copy.deployments, 'preprod-v2', 'params.json'));
  assertMismatch(evaluate(copy), /preprod-v2: no script contexts/);
});

test('a missing, an empty or an unexpected context file exits 1', () => {
  const missing = copyOfPreprodV1();
  rmSync(join(missing.contextFolder, 'cancel_ok.hex'));
  assertMismatch(evaluate(missing), /cancel_ok\.hex is missing/);

  const empty = copyOfPreprodV1();
  writeFileSync(join(empty.contextFolder, 'cancel_ok.hex'), '');
  assertMismatch(evaluate(empty), /cancel_ok\.hex does not hold lowercase hex bytes/);

  const extra = copyOfPreprodV1();
  copyFileSync(join(extra.contextFolder, 'purchase_ok.hex'), join(extra.contextFolder, 'purchase_twice.hex'));
  assertMismatch(evaluate(extra), /purchase_twice\.hex: no expected verdict/);
});

test('a context file that is not the bytes its test pins exits 1', () => {
  const copy = copyOfPreprodV1();
  writeFileSync(join(copy.contextFolder, 'purchase_ok.hex'), `${contextHex('purchase_fee_short')}\n`);
  assertMismatch(evaluate(copy), /purchase_ok\.hex is not the bytes pinned by test preprod_v1_purchase_ok/);
});

test('contexts built for another script hash or another fee address exit 1', () => {
  const hash = copyOfPreprodV1();
  const script = readJson(join(hash.folder, 'script.json'));
  writeJson(join(hash.folder, 'script.json'), { ...script, scriptHash: flip(script.scriptHash) });
  assertMismatch(evaluate(hash), /not at the deployment's script hash/);

  const fee = copyOfPreprodV1();
  const params = readJson(join(fee.folder, 'params.json'));
  const feeAddress = baseAddress({ network: 'preprod', type: 1, paymentHash: madeUpKeyHash('fee'), stakeHash: madeUpKeyHash('stake') });
  writeJson(join(fee.folder, 'params.json'), { ...params, feeAddress });
  assertMismatch(evaluate(fee), /no output at the deployment's fee address/);
});

test('bad input exits 2: no deployment, a badly named deployment folder, an unknown option', () => {
  const empty = dirs.make('eval-applied-empty-');
  assertBadInput(
    runScript('eval-applied.mjs', ['--dir', empty, '--contexts', REAL_CONTEXTS, '--tests', REAL_TESTS]),
    /no deployment folder with a script\.json/,
  );

  const badName = copyOfPreprodV1();
  mkdirSync(join(badName.deployments, 'preprod-latest'));
  copyFileSync(join(badName.folder, 'script.json'), join(badName.deployments, 'preprod-latest', 'script.json'));
  assertBadInput(evaluate(badName), /preprod-latest/);

  assertBadInput(runScript('eval-applied.mjs', ['--network', 'preprod']), /network/);
  assertBadInput(evaluate(copyOfPreprodV1(), { env: { ...process.env, PATH: '/nonexistent' } }), /aiken/);
});

// ---------------------------------------------------------------------------------------------
// Evaluating the applied scripts (Aiken v1.1.24)

aikenTest('the committed deployments give every expected verdict, with the budget.md figures for the purchases', () => {
  const result = runScript('eval-applied.mjs');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const rows = Object.fromEntries(
    result.stdout
      .split('\n')
      .filter((line) => line.startsWith('preprod-v1 '))
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .map(([, name, expected, verdict, mem, cpu]) => [name, { expected, verdict, mem, cpu }]),
  );
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(EXPECTED).sort());
  for (const [name, row] of Object.entries(rows)) {
    assert.equal(row.verdict, EXPECTED[name], name);
    assert.equal(row.expected, EXPECTED[name], name);
  }
  // The single buy of docs/budget.md, from the compiled script with the parameters applied.
  assert.deepEqual([rows.purchase_no_royalty.mem, rows.purchase_no_royalty.cpu], ['223,756', '90,225,409']);
  assert.deepEqual([rows.purchase_ok.mem, rows.purchase_ok.cpu], ['298,562', '119,908,574']);
  assert.deepEqual([rows.purchase_three_royalties.mem, rows.purchase_three_royalties.cpu], ['448,174', '179,274,904']);
  assert.match(result.stdout, /7 contexts on 1 deployment: 7 as expected, 0 unexpected/);
});

aikenTest('a context whose verdict is not the expected one exits 1', () => {
  // The fee-short bytes filed (and pinned) as the correct purchase: every static check passes and
  // the applied script refuses the purchase that was expected to pass.
  const copy = copyOfPreprodV1();
  const short = contextHex('purchase_fee_short');
  writeFileSync(join(copy.contextFolder, 'purchase_ok.hex'), `${short}\n`);
  const source = readFileSync(copy.tests, 'utf8');
  writeFileSync(copy.tests, source.replace(`#"${contextHex('purchase_ok')}"`, `#"${short}"`));
  const result = evaluate(copy);
  assertMismatch(result, /UNEXPECTED: preprod-v1 purchase_ok: expected success, got failure/);
  assert.match(result.stdout, /7 contexts on 1 deployment: 6 as expected, 1 unexpected/);
});
