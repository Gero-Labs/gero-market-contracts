import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { deploymentRecordProblems } from './lib/deployment.mjs';
import { ROOT, alwaysFailAddressFor, deploymentRecordFor, feeAddressFor, madeUpKeyHash, v1Params } from './test-helpers.mjs';

// The checks that tie a deployment.json to the files of its folder. They are called directly
// here; verify-deployments.test.mjs runs them through the script. The record is built by
// test-helpers from the folder files, with the always-fail address derived by hand, and every
// tampered copy is made here, so a test never compares the check with itself.

const FOLDER = join(ROOT, 'deployments', 'preprod-v1');
const read = (name) => JSON.parse(readFileSync(join(FOLDER, name), 'utf8'));

/** What the check is given about the folder: its name and its four parsed files. */
function preprodV1() {
  return {
    network: 'preprod',
    version: 1,
    script: read('script.json'),
    params: read('params.json'),
    feeAddress: read('fee-address.json'),
    plutus: read('plutus.json'),
  };
}

/** A folder for another network and version; the files need not be a real deployment, only consistent. */
function synthetic(network, version) {
  const feeAddress = feeAddressFor(network, version);
  return {
    network,
    version,
    script: { scriptHash: madeUpKeyHash(`script-${network}-${version}`), compiledCode: '00' },
    params: v1Params(feeAddress.address),
    feeAddress,
    plutus: read('plutus.json'),
  };
}

const problemsFor = (record, folder = preprodV1()) => deploymentRecordProblems(record, folder);
const clone = (value) => structuredClone(value);
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

test('a record taken from the folder files passes: the committed preprod-v1, and made-up folders on both networks', () => {
  assert.deepEqual(problemsFor(deploymentRecordFor(preprodV1())), []);
  for (const [network, version] of [['preprod', 1], ['preprod', 2], ['mainnet', 1], ['mainnet', 24], ['mainnet', 256]]) {
    const folder = synthetic(network, version);
    assert.deepEqual(problemsFor(deploymentRecordFor(folder), folder), [], `${network}-v${version}`);
  }
});

test('the reference script output may be any index, and a null cap is the same null in params.json', () => {
  for (const index of ['0', '1', '23', '24', '255', '256', '65535']) {
    assert.deepEqual(problemsFor(deploymentRecordFor(preprodV1(), `${'0f'.repeat(32)}#${index}`)), [], index);
  }
  const folder = preprodV1();
  folder.params.maxFeeLovelace = null;
  assert.deepEqual(problemsFor(deploymentRecordFor(folder), folder), []);
  const changed = deploymentRecordFor(folder);
  changed.params.maxFeeLovelace = 5_000_000;
  assert.match(problemsFor(changed, folder).join('\n'), /params\.maxFeeLovelace/);
});

// Each row: what is wrong, how to make the record wrong, and what the problem must name.
const WRONG = [
  ['network of the other net', (r) => { r.network = 'mainnet'; }, /network/],
  ['network in another case', (r) => { r.network = 'Preprod'; }, /network/],
  ['network not a string', (r) => { r.network = 0; }, /network/],
  ['version of the next deployment', (r) => { r.version = 2; }, /version/],
  ['version as a string', (r) => { r.version = '1'; }, /version/],
  ['version fractional', (r) => { r.version = 1.5; }, /version/],
  ['scriptHash of another script', (r) => { r.scriptHash = flip(r.scriptHash); }, /scriptHash/],
  ['scriptHash in upper case', (r) => { r.scriptHash = r.scriptHash.toUpperCase(); }, /scriptHash/],
  ['scriptHash too short', (r) => { r.scriptHash = r.scriptHash.slice(2); }, /scriptHash/],
  ['scriptHash not a string', (r) => { r.scriptHash = 7; }, /scriptHash/],
  ['referenceScript empty', (r) => { r.referenceScript = ''; }, /referenceScript/],
  ['referenceScript with no index', (r) => { r.referenceScript = 'ab'.repeat(32); }, /referenceScript/],
  ['referenceScript with an empty index', (r) => { r.referenceScript = `${'ab'.repeat(32)}#`; }, /referenceScript/],
  ['referenceScript with a short transaction id', (r) => { r.referenceScript = `${'ab'.repeat(31)}#0`; }, /referenceScript/],
  ['referenceScript with a long transaction id', (r) => { r.referenceScript = `${'ab'.repeat(33)}#0`; }, /referenceScript/],
  ['referenceScript with an upper-case transaction id', (r) => { r.referenceScript = `${'AB'.repeat(32)}#0`; }, /referenceScript/],
  ['referenceScript with a non-hex transaction id', (r) => { r.referenceScript = `${'zz'.repeat(32)}#0`; }, /referenceScript/],
  ['referenceScript with a negative index', (r) => { r.referenceScript = `${'ab'.repeat(32)}#-1`; }, /referenceScript/],
  ['referenceScript with a leading zero in the index', (r) => { r.referenceScript = `${'ab'.repeat(32)}#01`; }, /referenceScript/],
  ['referenceScript with a fractional index', (r) => { r.referenceScript = `${'ab'.repeat(32)}#1.5`; }, /referenceScript/],
  ['referenceScript with an index beyond 65535', (r) => { r.referenceScript = `${'ab'.repeat(32)}#65536`; }, /referenceScript/],
  ['referenceScript with two indexes', (r) => { r.referenceScript = `${'ab'.repeat(32)}#0#1`; }, /referenceScript/],
  ['referenceScript not a string', (r) => { r.referenceScript = { txHash: 'ab'.repeat(32), index: 0 }; }, /referenceScript/],
  ['referenceScriptAddress of mainnet', (r) => { r.referenceScriptAddress = alwaysFailAddressFor('mainnet'); }, /referenceScriptAddress/],
  ['referenceScriptAddress that is the fee address', (r) => { r.referenceScriptAddress = r.feeAddress; }, /referenceScriptAddress/],
  ['referenceScriptAddress in upper case', (r) => { r.referenceScriptAddress = r.referenceScriptAddress.toUpperCase(); }, /referenceScriptAddress/],
  ['referenceScriptAddress not a string', (r) => { r.referenceScriptAddress = null; }, /referenceScriptAddress/],
  ['feeAddress of another fee address', (r) => { r.feeAddress = feeAddressFor('preprod', 2).address; }, /feeAddress/],
  ['feeAddress not a string', (r) => { r.feeAddress = {}; }, /feeAddress/],
  ['feeNativeScript with a signer swapped', (r) => { r.feeNativeScript.scripts[0].scripts[1].keyHash = madeUpKeyHash('someone-else'); }, /feeNativeScript/],
  ['feeNativeScript with another slot', (r) => { r.feeNativeScript.scripts[1].slot = 2; }, /feeNativeScript/],
  ['feeNativeScript with a required count of 3', (r) => { r.feeNativeScript.scripts[0].required = 3; }, /feeNativeScript/],
  ['feeNativeScript with an extra field', (r) => { r.feeNativeScript.note = 'x'; }, /feeNativeScript/],
  ['feeNativeScript of another version', (r) => { r.feeNativeScript = feeAddressFor('preprod', 2).nativeScript; }, /feeNativeScript/],
  ['feeNativeScript missing its content', (r) => { r.feeNativeScript = {}; }, /feeNativeScript/],
  ['params.feeBps changed', (r) => { r.params.feeBps = 101; }, /params\.feeBps/],
  ['params.feeBps as a string', (r) => { r.params.feeBps = '100'; }, /params\.feeBps/],
  ['params.minFeeLovelace changed', (r) => { r.params.minFeeLovelace = 1_500_001; }, /params\.minFeeLovelace/],
  ['params.maxFeeLovelace changed', (r) => { r.params.maxFeeLovelace = 5_000_001; }, /params\.maxFeeLovelace/],
  ['params.maxFeeLovelace null while params.json has a cap', (r) => { r.params.maxFeeLovelace = null; }, /params\.maxFeeLovelace/],
  ['params with an extra field', (r) => { r.params.feeAddress = r.feeAddress; }, /params/],
  ['params missing a field', (r) => { delete r.params.minFeeLovelace; }, /params/],
  ['params not an object', (r) => { r.params = [100, 1_500_000, 5_000_000]; }, /params/],
  ['plutusVersion V2', (r) => { r.plutusVersion = 'V2'; }, /plutusVersion/],
  ['plutusVersion in lower case', (r) => { r.plutusVersion = 'v3'; }, /plutusVersion/],
  ['plutusVersion as a number', (r) => { r.plutusVersion = 3; }, /plutusVersion/],
  ['aikenVersion of the old default compiler', (r) => { r.aikenVersion = 'v1.1.16'; }, /aikenVersion/],
  ['aikenVersion with no leading v', (r) => { r.aikenVersion = '1.1.24'; }, /aikenVersion/],
  ['aikenVersion with the build hash', (r) => { r.aikenVersion = 'v1.1.24+bacbeb3'; }, /aikenVersion/],
  ['stdlibVersion with no leading v', (r) => { r.stdlibVersion = '4.0.0'; }, /stdlibVersion/],
  ['stdlibVersion that is a name', (r) => { r.stdlibVersion = 'latest'; }, /stdlibVersion/],
  ['stdlibVersion empty', (r) => { r.stdlibVersion = ''; }, /stdlibVersion/],
  ['sourceCommit a branch name', (r) => { r.sourceCommit = 'main'; }, /sourceCommit/],
  ['sourceCommit abbreviated', (r) => { r.sourceCommit = 'a'.repeat(7); }, /sourceCommit/],
  ['sourceCommit of 41 characters', (r) => { r.sourceCommit = 'a'.repeat(41); }, /sourceCommit/],
  ['sourceCommit in upper case', (r) => { r.sourceCommit = 'A'.repeat(40); }, /sourceCommit/],
  ['uplcVerification empty', (r) => { r.uplcVerification = ''; }, /uplcVerification/],
  ['uplcVerification only spaces', (r) => { r.uplcVerification = '   '; }, /uplcVerification/],
  ['uplcVerification not a string', (r) => { r.uplcVerification = 7; }, /uplcVerification/],
];

test('a record that differs from its folder in any one field is refused, and the problem names the field', () => {
  for (const [what, mutate, pattern] of WRONG) {
    const record = deploymentRecordFor(preprodV1());
    mutate(record);
    const problems = problemsFor(record);
    assert.ok(problems.length > 0, `${what}: no problem found`);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${what}: ${problems.join(' | ')}`);
  }
});

test('the folder decides: the same record in a folder with other files is refused', () => {
  const record = deploymentRecordFor(preprodV1());
  const otherScript = preprodV1();
  otherScript.script = { ...otherScript.script, scriptHash: flip(otherScript.script.scriptHash) };
  assert.match(problemsFor(record, otherScript).join('\n'), /scriptHash/);

  const otherParams = preprodV1();
  otherParams.params = { ...otherParams.params, feeBps: 200 };
  assert.match(problemsFor(record, otherParams).join('\n'), /params\.feeBps/);

  const otherParamsAddress = preprodV1();
  otherParamsAddress.params = { ...otherParamsAddress.params, feeAddress: feeAddressFor('preprod', 2).address };
  assert.match(problemsFor(record, otherParamsAddress).join('\n'), /feeAddress .*params\.json/);

  const otherFee = preprodV1();
  otherFee.feeAddress = feeAddressFor('preprod', 2);
  const problems = problemsFor(record, otherFee).join('\n');
  assert.match(problems, /feeNativeScript/);
  assert.match(problems, /feeAddress/);

  const mainnet = synthetic('mainnet', 1);
  assert.match(problemsFor(record, mainnet).join('\n'), /network/);
  const version2 = preprodV1();
  version2.version = 2;
  assert.match(problemsFor(record, version2).join('\n'), /version/);

  const otherCompiler = preprodV1();
  otherCompiler.plutus = { ...otherCompiler.plutus, preamble: { ...otherCompiler.plutus.preamble, compiler: { name: 'Aiken', version: 'v1.1.16+abcdef0' } } };
  assert.match(problemsFor(record, otherCompiler).join('\n'), /aikenVersion/);
  const otherPlutus = preprodV1();
  otherPlutus.plutus = { ...otherPlutus.plutus, preamble: { ...otherPlutus.plutus.preamble, plutusVersion: 'v2' } };
  assert.match(problemsFor(record, otherPlutus).join('\n'), /plutusVersion/);
  // The contract is PlutusV3 whatever the blueprint says: a V2 record is refused even for a V2 blueprint.
  const v2Record = deploymentRecordFor(preprodV1());
  v2Record.plutusVersion = 'V2';
  assert.match(problemsFor(v2Record, otherPlutus).join('\n'), /plutusVersion/);
  const noPreamble = preprodV1();
  noPreamble.plutus = { validators: [] };
  assert.match(problemsFor(record, noPreamble).join('\n'), /aikenVersion|plutusVersion/);
});

test('the record has exactly the thirteen keys: a missing, an extra or a pollution key is refused', () => {
  const valid = deploymentRecordFor(preprodV1());
  assert.equal(Object.keys(valid).length, 13);
  for (const key of Object.keys(valid)) {
    const record = clone(valid);
    delete record[key];
    assert.ok(problemsFor(record).length > 0, `without ${key}`);
  }
  const extra = { ...clone(valid), signed: true };
  assert.match(problemsFor(extra).join('\n'), /exactly|keys/);
  const pollution = JSON.parse(`${JSON.stringify(valid).slice(0, -1)},"__proto__":{"network":"preprod"}}`);
  assert.ok(problemsFor(pollution).length > 0, 'a __proto__ key');
  for (const notRecord of [null, undefined, [], 'deployment', 7, true]) {
    const problems = problemsFor(notRecord);
    assert.ok(problems.length > 0, String(notRecord));
  }
});

test('a wholly wrong record gives a list of problems and never throws', () => {
  const nonsense = {
    network: {}, version: [], scriptHash: null, referenceScript: 1, referenceScriptAddress: [], feeAddress: false,
    feeNativeScript: 'x', params: 'y', plutusVersion: {}, aikenVersion: [], stdlibVersion: null, sourceCommit: 5, uplcVerification: {},
  };
  const problems = problemsFor(nonsense);
  for (const field of Object.keys(nonsense)) {
    assert.ok(problems.some((problem) => problem.includes(field)), `${field}: ${problems.join(' | ')}`);
  }
});
