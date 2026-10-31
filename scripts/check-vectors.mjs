// Cross-checks the tag vectors that the off-chain code is tested against.
//
// Usage: node scripts/check-vectors.mjs [--vectors <path>] [--tests <path>]
//
// Defaults (relative to the repository root, whatever the current folder is):
//   --vectors test-vectors/tags.json
//   --tests   lib/gero_market/tag.test.ak
//
// For every vector `{ txId, index, serialised, tag }` it
//   1. builds `d8799f 5820 <tx id> <CBOR uint index> ff` by hand (no Aiken, no Plutus library)
//      and compares it with `serialised`;
//   2. hashes those bytes with blake2b-256 and compares the result with `tag`;
//   3. looks for `#"<tag>"` in the Aiken test file, outside `//` comments, so that the
//      on-chain tests assert the very same tag.
// An index outside 0..2^32-1 is a mismatch (the tag rule only covers up to a four-byte uint).
//
// Exit 0 and no output when everything agrees. Exit 1 and one line per mismatch on stdout
// otherwise. A file that cannot be read or parsed, or a bad option, exits 2 with a message on
// stderr.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VECTORS = 'test-vectors/tags.json';
const DEFAULT_TESTS = 'lib/gero_market/tag.test.ak';

const MAX_INDEX = 2 ** 32 - 1;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/;

/** CBOR major type 0, shortest form: the argument fits the initial byte, or 1, 2 or 4 more bytes. */
function cborUint(n) {
  if (n < 24) return [n];
  if (n < 256) return [0x18, n];
  if (n < 65536) return [0x19, n >>> 8, n & 0xff];
  return [0x1a, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** What Plutus serialises an output reference to: an indefinite-length constructor 0. */
function serialiseOutRef(txId, index) {
  return Uint8Array.from([
    0xd8, 0x79, 0x9f, // tag 121 (constructor 0), start of an indefinite-length array
    0x58, 0x20, ...hexToBytes(txId), // byte string of 32 bytes
    ...cborUint(index),
    0xff, // break
  ]);
}

/** The Aiken test source without `//` comments, so a tag mentioned in a comment does not count. */
function withoutComments(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function check(vector, position, code, testsName) {
  if (vector === null || typeof vector !== 'object' || Array.isArray(vector)) {
    return [`vector ${position}: not an object`];
  }
  const label = `index ${JSON.stringify(vector.index)}`;
  const { txId, index, serialised, tag } = vector;

  const bad = [];
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    bad.push(`${label}: out of range, must be an integer from 0 to ${MAX_INDEX}`);
  }
  if (typeof txId !== 'string' || !HEX_32_BYTES.test(txId)) {
    bad.push(`${label}: txId is not 64 lowercase hex characters`);
  }
  if (typeof serialised !== 'string' || !HEX_BYTES.test(serialised)) {
    bad.push(`${label}: serialised is not lowercase hex bytes`);
  }
  if (typeof tag !== 'string' || !HEX_32_BYTES.test(tag)) {
    bad.push(`${label}: tag is not 64 lowercase hex characters`);
  }
  if (bad.length > 0) return bad; // nothing below can be computed

  const built = serialiseOutRef(txId, index);
  const problems = [];
  if (bytesToHex(built) !== serialised) {
    problems.push(`${label}: serialised mismatch: built ${bytesToHex(built)}, file has ${serialised}`);
  }
  const expectedTag = bytesToHex(blake2b(built, { dkLen: 32 }));
  if (expectedTag !== tag) {
    problems.push(`${label}: tag mismatch: built ${expectedTag}, file has ${tag}`);
  }
  if (!code.includes(`#"${tag}"`)) {
    problems.push(`${label}: tag ${tag} not in ${testsName}`);
  }
  return problems;
}

function main() {
  const { values } = parseArgs({
    options: { vectors: { type: 'string' }, tests: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const vectorsPath = values.vectors === undefined ? join(ROOT, DEFAULT_VECTORS) : resolve(values.vectors);
  const testsPath = values.tests === undefined ? join(ROOT, DEFAULT_TESTS) : resolve(values.tests);
  const testsName = values.tests ?? DEFAULT_TESTS;

  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
  const code = withoutComments(readFileSync(testsPath, 'utf8'));

  const problems = [];
  if (!Array.isArray(vectors)) {
    problems.push('the vectors file must hold a JSON array');
  } else if (vectors.length === 0) {
    problems.push(`no vectors in ${values.vectors ?? DEFAULT_VECTORS}`);
  } else {
    vectors.forEach((vector, position) => problems.push(...check(vector, position, code, testsName)));
  }

  if (problems.length > 0) {
    console.log(problems.join('\n'));
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`check-vectors: ${error.message}`);
  process.exitCode = 2;
}
