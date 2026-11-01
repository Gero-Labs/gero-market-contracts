import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ROOT, assertBadInput, runScript, tempDirs } from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

const PREPROD_V1 = join(ROOT, 'deployments', 'preprod-v1');
const FILES = ['fee-address.json', 'params.json', 'plutus.json', 'script.json'];

/** Flips the first hex digit, so the value stays valid hex of the same length. */
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

/** A deployments folder holding a copy of the committed preprod-v1 under each of `names`. */
function deployments(...names) {
  const dir = dirs.make('verify-deployments-');
  for (const name of names) {
    mkdirSync(join(dir, name));
    for (const file of FILES) copyFileSync(join(PREPROD_V1, file), join(dir, name, file));
  }
  return dir;
}

const verifyAll = (dir) => runScript('verify-deployments.mjs', ['--dir', dir]);

test('the committed deployments all verify', () => {
  const result = runScript('verify-deployments.mjs');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified preprod-v1: both implementations give script hash 558802cc2e2f21e4e13662cdf73f979ce0140e7dbd7ce13911a9063d/);
  assert.match(result.stdout, /1 deployment verified/);
});

test('a folder that is still being prepared (no script.json) is left out', () => {
  const dir = deployments('preprod-v1');
  mkdirSync(join(dir, 'preprod-v2'));
  copyFileSync(join(PREPROD_V1, 'fee-address.json'), join(dir, 'preprod-v2', 'fee-address.json'));
  const result = verifyAll(dir);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 deployment verified/);
  assert.doesNotMatch(result.stdout, /preprod-v2/);
});

test('one deployment that does not verify makes the whole run exit 1, after checking the others', () => {
  // The same folder as preprod-v1 filed as version 2: its fee address names slot 1, so it is not
  // version 2's. The tampered copy of version 1 has another script hash in script.json.
  const dir = deployments('preprod-v1', 'preprod-v2');
  const tampered = deployments('preprod-v1');
  const path = join(tampered, 'preprod-v1', 'script.json');
  const script = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify({ ...script, scriptHash: flip(script.scriptHash) }, null, 2)}\n`);

  const both = verifyAll(dir);
  assert.equal(both.status, 1, `${both.stdout}\n${both.stderr}`);
  assert.match(both.stdout, /verified preprod-v1/);
  assert.match(both.stdout, /preprod-v2[\s\S]*after slot 1, this deployment is version 2/);
  assert.match(both.stdout, /1 of 2 deployments failed/);

  const one = verifyAll(tampered);
  assert.equal(one.status, 1, `${one.stdout}\n${one.stderr}`);
  assert.match(one.stdout, /MISMATCH/);
});

test('bad input exits 2: no deployment, a badly named folder with a script.json, an unknown option', () => {
  assertBadInput(verifyAll(dirs.make('verify-deployments-empty-')), /no deployment folder with a script\.json/);
  assertBadInput(verifyAll(deployments('preprod-v1', 'preprod-latest')), /preprod-latest/);
  assertBadInput(verifyAll(deployments('testnet-v1')), /network must be preprod or mainnet/);
  assertBadInput(runScript('verify-deployments.mjs', ['--network', 'preprod']), /network/);
});

test('a deployment folder whose files cannot be read exits 2 and names the folder', () => {
  const dir = deployments('preprod-v1');
  writeFileSync(join(dir, 'preprod-v1', 'params.json'), '{ not json');
  const result = verifyAll(dir);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /preprod-v1[\s\S]*params\.json/);
});
