// Helpers shared by the deployment tooling tests. This is not a test file: `node --test` only
// picks up `*.test.mjs`.
//
// Everything that checks the tools' answers is written here a second time on purpose, without
// Lucid Evolution and without Aiken's help (native script CBOR, bech32, key hashes), so a test
// compares two separate implementations and not a tool with itself.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BLUEPRINT = join(ROOT, 'plutus.json');

// ---------------------------------------------------------------------------------------------
// Temporary folders and running the real scripts

/** Temporary folders that `cleanup` removes; call it from `after()`. */
export function tempDirs() {
  const created = [];
  return {
    make(prefix = 'gero-deploy-') {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      created.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A symlink to the repo inside `folder`, so a script can be started through a path that is not its real one. */
export function symlinkedRepo(folder) {
  const link = join(folder, 'repo-link');
  symlinkSync(ROOT, link, 'dir');
  return link;
}

/**
 * Runs one of the scripts in `scripts/` for real. Without `cwd` it runs from the repo root.
 * `repo` is the repo path the script is started through (a symlink to it, for instance).
 */
export function runScript(name, args = [], { cwd = ROOT, env, repo = ROOT } = {}) {
  const result = spawnSync(process.execPath, [join(repo, 'scripts', name), ...args], {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The JSON a script printed; fails the test with the script's output when it is not JSON. */
export function parseJsonOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`not JSON (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

/** A bad-input exit: status 2, a message on stderr, nothing on stdout. */
export function assertBadInput(result, pattern, message) {
  assert.equal(result.status, 2, `${message ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, '', message);
  assert.match(result.stderr, pattern, message);
}

// ---------------------------------------------------------------------------------------------
// Aiken

const AIKEN_VERSION = /^aiken v1\.1\.24\b/;

/** Whether `aiken` on PATH is v1.1.24, and why not when it is not. */
export function detectAiken(env = process.env) {
  const result = spawnSync('aiken', ['--version'], { env, encoding: 'utf8' });
  if (result.error) return { ok: false, reason: `aiken did not run: ${result.error.message}` };
  const line = result.stdout.trim();
  if (!AIKEN_VERSION.test(line)) return { ok: false, reason: `aiken on PATH is "${line}", not v1.1.24` };
  return { ok: true, reason: line };
}

/**
 * A test that needs Aiken v1.1.24. Without it the test is skipped with a message, except in CI
 * (`CI` set), where it fails: a CI run that silently skips these would prove nothing.
 */
export function aikenTest(name, fn) {
  const aiken = detectAiken();
  if (aiken.ok) return test(name, fn);
  if (process.env.CI) {
    return test(name, () => assert.fail(`CI needs aiken v1.1.24 on PATH: ${aiken.reason}`));
  }
  return test(
    name,
    {
      skip:
        `${aiken.reason}. Put it first on PATH: ` +
        '$HOME/.aiken/versions/v1.1.24/aiken-aarch64-apple-darwin',
    },
    fn,
  );
}

/**
 * Applies the given CBOR parameters to the committed blueprint with Aiken, exactly as a person
 * would on the command line, and returns the resulting hash, compiled code and blueprint path.
 * Aiken checks each parameter's shape against the blueprint schema; when it refuses one, this
 * returns `{ rejected }` with Aiken's message instead. The tests use it to build deployments with
 * a deliberately wrong encoding.
 */
export function aikenApply(parameters, dir) {
  const run = (args) => spawnSync('aiken', args, { cwd: ROOT, encoding: 'utf8' });
  let current = BLUEPRINT;
  for (const [position, cbor] of parameters.entries()) {
    const next = join(dir, `applied-${position}.json`);
    const applied = run(['blueprint', 'apply', cbor, '--in', current, '--out', next, '--module', 'listing', '--validator', 'listing']);
    if (applied.status !== 0) return { rejected: `${applied.stdout}${applied.stderr}` };
    current = next;
  }
  const hash = run(['blueprint', 'hash', '--in', current, '--module', 'listing', '--validator', 'listing']);
  assert.equal(hash.status, 0, `${hash.stdout}\n${hash.stderr}`);
  const blueprint = JSON.parse(readFileSync(current, 'utf8'));
  const validator = blueprint.validators.find((v) => v.title === 'listing.listing.spend');
  return { scriptHash: hash.stdout.trim(), compiledCode: validator.compiledCode, blueprintPath: current };
}

// ---------------------------------------------------------------------------------------------
// Key hashes, bech32 and the native script, written without the libraries under test

/** A made-up 28-byte key hash (56 hex characters) derived from a label. No real key behind it. */
export function madeUpKeyHash(label) {
  return bytesToHex(blake2b(new TextEncoder().encode(`gero-test-key:${label}`), { dkLen: 28 }));
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= generator[i];
  }
  return checksum;
}

function bech32HrpExpand(hrp) {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

function convertBits(data, from, to, pad) {
  let accumulator = 0;
  let bits = 0;
  const out = [];
  for (const value of data) {
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >> bits) & ((1 << to) - 1));
    }
    accumulator &= (1 << bits) - 1;
  }
  if (pad && bits > 0) out.push((accumulator << (to - bits)) & ((1 << to) - 1));
  if (!pad) assert.ok(bits < from && accumulator === 0, 'bech32 padding must be zero');
  return out;
}

/** Decodes a bech32 string (lowercase, checksum verified) into its prefix and bytes. */
export function bech32Decode(text) {
  assert.equal(text, text.toLowerCase(), 'bech32 must be lowercase');
  const split = text.lastIndexOf('1');
  const hrp = text.slice(0, split);
  const data = [...text.slice(split + 1)].map((c) => {
    const value = BECH32_CHARSET.indexOf(c);
    assert.ok(value >= 0, `bad bech32 character ${c}`);
    return value;
  });
  assert.equal(bech32Polymod([...bech32HrpExpand(hrp), ...data]), 1, 'bech32 checksum');
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

/** Encodes bytes as bech32 with the given prefix. */
export function bech32Encode(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const mod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join('')}`;
}

/** CBOR initial byte(s) for a major type and an argument below 2^32, in the shortest form. */
function cborHead(major, n) {
  assert.ok(Number.isInteger(n) && n >= 0 && n < 2 ** 32);
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/**
 * The CBOR of `all [ atLeast 2 [sig a, sig b, sig c], invalidBefore slot ]`, written by hand from
 * the ledger's native script format: [1, [[3, 2, [[0, a], [0, b], [0, c]]], [4, slot]]].
 */
export function nativeScriptCbor(keyHashes, slot) {
  const sig = (hash) => [...cborHead(4, 2), ...cborHead(0, 0), ...cborHead(2, 28), ...hexToBytes(hash)];
  return Uint8Array.from([
    ...cborHead(4, 2), ...cborHead(0, 1), // all
    ...cborHead(4, 2), // two sub-scripts
    ...cborHead(4, 3), ...cborHead(0, 3), ...cborHead(0, 2), // atLeast 2 of
    ...cborHead(4, keyHashes.length), ...keyHashes.flatMap(sig),
    ...cborHead(4, 2), ...cborHead(0, 4), ...cborHead(0, slot), // invalidBefore slot
  ]);
}

/** A native script's hash: blake2b-224 of the tag byte 0x00 followed by its CBOR. */
export function nativeScriptHash(keyHashes, slot) {
  return bytesToHex(blake2b(Uint8Array.from([0, ...nativeScriptCbor(keyHashes, slot)]), { dkLen: 28 }));
}

/**
 * A base address built by hand: header byte (address type in the high nibble, network in the low
 * one), then the two 28-byte credentials. Type 1 is a script payment part with a key stake part.
 */
export function baseAddress({ network, type, paymentHash, stakeHash }) {
  const networkId = network === 'mainnet' ? 1 : 0;
  const bytes = Uint8Array.from([(type << 4) | networkId, ...hexToBytes(paymentHash), ...hexToBytes(stakeHash)]);
  return bech32Encode(networkId === 1 ? 'addr' : 'addr_test', bytes);
}

/** A pointer address (type 5: script payment part, stake given by a chain pointer 1, 2, 3). */
export function pointerAddress({ network, paymentHash }) {
  const networkId = network === 'mainnet' ? 1 : 0;
  const bytes = Uint8Array.from([(5 << 4) | networkId, ...hexToBytes(paymentHash), 1, 2, 3]);
  return bech32Encode(networkId === 1 ? 'addr' : 'addr_test', bytes);
}

/** The pieces of a base address, read back with the hand-written bech32 decoder. */
export function splitBaseAddress(address) {
  const { hrp, bytes } = bech32Decode(address);
  assert.equal(bytes.length, 57, 'a base address is 57 bytes');
  return {
    hrp,
    header: bytes[0],
    paymentHash: bytesToHex(bytes.slice(1, 29)),
    stakeHash: bytesToHex(bytes.slice(29, 57)),
  };
}

// ---------------------------------------------------------------------------------------------
// A real deployment folder for the tools to work on

/** The v1 parameters of the contract with a given fee address. */
export function v1Params(feeAddress, overrides = {}) {
  return {
    feeAddress,
    feeBps: 100,
    minFeeLovelace: 1_500_000,
    maxFeeLovelace: 5_000_000,
    ...overrides,
  };
}

/** Writes `<dir>/<network>-v<version>/params.json` and returns its path. */
export function writeParams(dir, network, version, params) {
  const folder = join(dir, `${network}-v${version}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'params.json');
  writeFileSync(path, `${JSON.stringify(params, null, 2)}\n`);
  return path;
}

/** A fee address from the real fee-address script for three made-up signers. */
export function feeAddressFor(network, version) {
  const signers = ['signer-a', 'signer-b', 'signer-c'].map(madeUpKeyHash);
  const result = runScript('fee-address.mjs', [
    '--network', network,
    '--version', String(version),
    '--signers', signers.join(','),
    '--stake', madeUpKeyHash('stake'),
  ]);
  assert.equal(result.status, 0, `fee-address failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
