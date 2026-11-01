// The tests that need Aiken v1.1.24 skip when it is missing on a developer machine and fail in CI.
// This runs a one-test fixture file in a child `node --test` with a controlled PATH and CI value.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

import { ROOT, tempDirs } from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

const HELPERS_URL = pathToFileURL(join(ROOT, 'scripts', 'test-helpers.mjs')).href;

/** Runs a fixture with one `aikenTest` and returns the exit status and the TAP summary. */
function runFixture({ path, ci }) {
  const dir = dirs.make('aiken-test-fixture-');
  const fixture = join(dir, 'fixture.test.mjs');
  writeFileSync(
    fixture,
    `import { aikenTest } from ${JSON.stringify(HELPERS_URL)};\naikenTest('needs aiken', () => {});\n`,
  );
  const env = { PATH: path };
  if (ci !== undefined) env.CI = ci;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  const count = (name) => Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
  return { status: result.status, pass: count('pass'), fail: count('fail'), skipped: count('skipped'), out: result.stdout };
}

function fakeAiken(version) {
  const dir = dirs.make('fake-aiken-');
  const path = join(dir, 'aiken');
  writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(path, 0o755);
  return dir;
}

test('without Aiken on PATH the test is skipped on a developer machine', () => {
  const result = runFixture({ path: dirs.make('empty-path-') });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.skipped, 1, result.out);
  assert.equal(result.fail, 0, result.out);
  assert.match(result.out, /v1\.1\.24/);
});

test('without Aiken on PATH the test fails in CI', () => {
  const result = runFixture({ path: dirs.make('empty-path-'), ci: 'true' });
  assert.notEqual(result.status, 0, result.out);
  assert.equal(result.fail, 1, result.out);
  assert.equal(result.skipped, 0, result.out);
});

test('an Aiken of another version is skipped locally and fails in CI', () => {
  const path = fakeAiken('aiken v1.1.16+abcdef0');
  const local = runFixture({ path });
  assert.equal(local.status, 0, local.out);
  assert.equal(local.skipped, 1, local.out);
  const ci = runFixture({ path, ci: '1' });
  assert.notEqual(ci.status, 0, ci.out);
  assert.equal(ci.fail, 1, ci.out);
});

test('Aiken v1.1.24 on PATH runs the test, in CI too', () => {
  const path = fakeAiken('aiken v1.1.24+bacbeb3');
  for (const ci of [undefined, 'true']) {
    const result = runFixture({ path, ci });
    assert.equal(result.status, 0, result.out);
    assert.equal(result.pass, 1, result.out);
    assert.equal(result.skipped, 0, result.out);
  }
});
