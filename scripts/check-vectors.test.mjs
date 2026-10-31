import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'check-vectors.mjs');
const REAL_VECTORS = join(ROOT, 'test-vectors', 'tags.json');
const REAL_TESTS = join(ROOT, 'lib', 'gero_market', 'tag.test.ak');

const created = [];

function newDir() {
  const dir = mkdtempSync(join(tmpdir(), 'check-vectors-'));
  created.push(dir);
  return dir;
}

/** Runs the real script. Without `cwd` it runs from a folder other than the repo root. */
function run(args = [], cwd = newDir()) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let dir;
beforeEach(() => {
  dir = newDir();
});

after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

/** A detected mismatch: exit 1, the finding on stdout, and no crash output on stderr. */
function assertMismatch(result, pattern, message) {
  assert.equal(result.status, 1, message);
  assert.equal(result.stderr, '', message);
  assert.match(result.stdout, pattern, message);
}

const realVectors = () => JSON.parse(readFileSync(REAL_VECTORS, 'utf8'));

/** Writes a vectors file into the temp folder and returns its path. */
function writeVectors(vectors) {
  const path = join(dir, 'tags.json');
  writeFileSync(path, JSON.stringify(vectors, null, 2));
  return path;
}

/** Writes a copy of the Aiken test file, changed by `edit`, and returns its path. */
function writeTests(edit = (text) => text) {
  const path = join(dir, 'tag.test.ak');
  writeFileSync(path, edit(readFileSync(REAL_TESTS, 'utf8')));
  return path;
}

/** Changes the first hex digit, so the value stays valid hex of the same length. */
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

test('the real vectors and the real Aiken tests agree (exit 0, run from any folder)', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('the real vectors pin the indices 0, 23, 24 and 256', () => {
  assert.deepEqual(
    realVectors().map((v) => v.index),
    [0, 23, 24, 256],
  );
});

test('a corrupted tag exits 1 and names the vector', () => {
  const vectors = realVectors();
  vectors[2].tag = flip(vectors[2].tag);
  assertMismatch(run(['--vectors', writeVectors(vectors)]), /index 24: tag/);
});

test('a corrupted serialised form exits 1 and names the vector', () => {
  const vectors = realVectors();
  vectors[3].serialised = flip(vectors[3].serialised);
  assertMismatch(run(['--vectors', writeVectors(vectors)]), /index 256: serialised/);
});

test('a corrupted tx id exits 1', () => {
  const vectors = realVectors();
  vectors[0].txId = flip(vectors[0].txId);
  assertMismatch(run(['--vectors', writeVectors(vectors)]), /index 0: serialised/);
});

test('a tag missing from the Aiken test file exits 1 and names the vector', () => {
  const vectors = realVectors();
  const missing = vectors[1].tag;
  const tests = writeTests((text) => {
    assert.ok(text.includes(missing), 'the real test file must hold the tag to begin with');
    return text.replaceAll(missing, flip(missing));
  });
  assertMismatch(run(['--vectors', REAL_VECTORS, '--tests', tests]), /index 23: tag .* not in /);
});

test('a tag that only appears in a comment does not count', () => {
  const vectors = realVectors();
  const tag = vectors[0].tag;
  const tests = writeTests((text) =>
    text
      .split('\n')
      .map((line) => (line.includes(tag) ? `// ${line}` : line))
      .join('\n'),
  );
  assertMismatch(run(['--vectors', REAL_VECTORS, '--tests', tests]), /index 0: tag .* not in /);
});

test('an index outside 0..2^32-1 exits 1', () => {
  for (const index of [-1, 4294967296, 1.5, '24', null]) {
    const vectors = realVectors();
    vectors[2].index = index;
    const message = `index ${JSON.stringify(index)} must be rejected`;
    assertMismatch(run(['--vectors', writeVectors(vectors)]), /index [^:]*: out of range/, message);
  }
});

test('an empty vectors file exits 1', () => {
  assertMismatch(run(['--vectors', writeVectors([])]), /no vectors/);
});

test('malformed hex fields exit 1', () => {
  for (const [field, value] of [
    ['txId', 'abcd'],
    ['txId', realVectors()[0].txId.toUpperCase()],
    ['tag', 'zz'.repeat(32)],
    ['serialised', 'abc'],
  ]) {
    const vectors = realVectors();
    vectors[0][field] = value;
    assertMismatch(run(['--vectors', writeVectors(vectors)]), /index 0: .*not .*hex/, `${field} ${value}`);
  }
});

test('a vectors file that is missing exits 2, not 0', () => {
  const result = run(['--vectors', join(dir, 'nope.json')]);
  assert.equal(result.status, 2);
  assert.notEqual(result.stderr, '');
});

test('accepts every CBOR width boundary, with serialised forms written by hand', () => {
  const txId = realVectors()[0].txId;
  const forms = [
    [255, '18ff'],
    [65535, '19ffff'],
    [65536, '1a00010000'],
    [4294967295, '1affffffff'],
  ];
  const vectors = forms.map(([index, uint]) => {
    const serialised = `d8799f5820${txId}${uint}ff`;
    return { txId, index, serialised, tag: bytesToHex(blake2b(hexToBytes(serialised), { dkLen: 32 })) };
  });
  const tests = join(dir, 'boundaries.test.ak');
  writeFileSync(tests, vectors.map((v) => `test t${v.index}() { x == #"${v.tag}" }`).join('\n'));
  const result = run(['--vectors', writeVectors(vectors), '--tests', tests]);
  assert.equal(result.stdout, '');
  assert.equal(result.status, 0);
});
