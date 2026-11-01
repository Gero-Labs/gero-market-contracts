// What fee-address.mjs, apply-params.mjs and verify-params.mjs have in common: reading and
// checking their input, the shape of a deployment folder, and the exit codes.
//
// Exit codes, as in the other scripts of this repo: 0 all good, 1 a check failed (a mismatch the
// script found), 2 bad input or a tool that could not run.
//
// Nothing here builds the Plutus data of the contract parameters. apply-params.mjs and
// verify-params.mjs each do that on their own, so that they stay two separate implementations.

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getAddressDetails, scriptFromNative, validatorToScriptHash } from '@lucid-evolution/lucid';

export { isMain } from './is-main.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BLUEPRINT_PATH = join(ROOT, 'plutus.json');
export const DEFAULT_DEPLOYMENTS_DIR = join(ROOT, 'deployments');

/** The validator whose script is deployed, and its parameters in declaration order. */
export const VALIDATOR_TITLE = 'listing.listing.spend';
export const PARAMETER_TITLES = ['fee_address', 'fee_bps', 'min_fee', 'max_fee'];

export const NETWORKS = {
  preprod: { lucid: 'Preprod', id: 0 },
  mainnet: { lucid: 'Mainnet', id: 1 },
};

/**
 * The version number is the `invalidBefore` slot of the fee address. That timelock is satisfied
 * only by a transaction whose validity interval has a lower bound of at least N: a spend from the
 * fee address must set `invalid_before >= N`, and a transaction with no lower bound fails the
 * script. Both networks are far beyond the cap, so a sweep can always pick a lower bound that is
 * both at least N and already in the past (the current slot works). A slip such as a Unix time
 * (a slot that lies decades ahead) is refused instead of producing a fee address that nobody can
 * spend from for years.
 */
export const MAX_VERSION = 1_000_000;

/** The deployment review's limit on `fee_bps` (spec 5.2); the contract itself allows below 10000. */
export const MAX_REVIEWED_FEE_BPS = 1000;

/** Bad input, or a tool that could not run: exit 2. */
export class UsageError extends Error {}

/** A check that found a mismatch: exit 1, the message goes to stdout. */
export class CheckFailure extends Error {}

// ---------------------------------------------------------------------------------------------
// Running

function reportFailure(name, error) {
  if (error instanceof CheckFailure) {
    console.log(error.message);
    process.exitCode = 1;
  } else {
    console.error(`${name}: ${error?.message ?? error}`);
    process.exitCode = 2;
  }
}

/** Runs `main`; turns a thrown UsageError, CheckFailure or any other error into an exit code. */
export function runCli(name, main) {
  try {
    main();
  } catch (error) {
    reportFailure(name, error);
  }
}

/** `runCli` for a `main` that returns a promise. */
export async function runCliAsync(name, main) {
  try {
    await main();
  } catch (error) {
    reportFailure(name, error);
  }
}

/** Command line options of the given `{ name: { type: 'string' } }`; anything else is an error. */
export function parseCli(options) {
  return parseArgs({ options, strict: true, allowPositionals: false }).values;
}

export function requireOption(values, name) {
  if (values[name] === undefined) throw new UsageError(`missing --${name}`);
  return values[name];
}

// ---------------------------------------------------------------------------------------------
// Values

export function parseNetwork(value) {
  // OX Agent: Prototype Pollution prevented by reading the allowlist with Object.hasOwn (no "constructor" or "__proto__")
  if (typeof value !== 'string' || !Object.hasOwn(NETWORKS, value)) {
    throw new UsageError(`--network must be preprod or mainnet, not "${value}"`);
  }
  return value;
}

export function parseVersion(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_VERSION) {
    throw new UsageError(`--version must be a whole number from 1 to ${MAX_VERSION}, not "${value}"`);
  }
  return Number(value);
}

const KEY_HASH = /^[0-9a-f]{56}$/;

/** A key hash: 28 bytes as 56 lowercase hex characters. */
export function parseKeyHash(value, option) {
  if (typeof value !== 'string' || !KEY_HASH.test(value)) {
    throw new UsageError(`${option}: "${value}" is not a key hash (56 lowercase hex characters)`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Files

export function readJsonFile(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${what} (${path}): ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${what} (${path}) is not valid JSON: ${error.message}`);
  }
}

/**
 * The files of the folder `<dir>/<network>-v<version>`. Network and version are already checked
 * (an allowlist and a plain number), and the folder must still resolve to inside `dir`.
 */
export function deploymentPaths(dir, network, version) {
  const base = resolve(dir);
  const folder = resolve(base, `${network}-v${version}`);
  // OX Agent: Path Traversal prevented by path normalization and base directory validation
  if (!folder.startsWith(base + sep)) throw new UsageError(`${network}-v${version} is not a folder inside ${base}`);
  return {
    folder,
    feeAddress: join(folder, 'fee-address.json'),
    params: join(folder, 'params.json'),
    plutus: join(folder, 'plutus.json'),
    script: join(folder, 'script.json'),
  };
}

/** script.json: `{ scriptHash, compiledCode }`, both checked for their shape (not for being the same script). */
export function readScriptJson(path) {
  const script = readJsonFile(path, 'script.json');
  if (typeof script?.scriptHash !== 'string' || !KEY_HASH.test(script.scriptHash)) {
    throw new UsageError(`script.json (${path}) has no scriptHash of 56 lowercase hex characters`);
  }
  if (typeof script.compiledCode !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(script.compiledCode)) {
    throw new UsageError(`script.json (${path}) has no compiledCode in hex`);
  }
  return script;
}

/** Whether anything is at `path`, a dangling symlink included (`existsSync` would follow it and say no). */
export function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new UsageError(`cannot look at ${path}: ${error.message}`);
  }
}

/** The committed, unapplied blueprint, and its validator, checked to have the expected parameters. */
export function readUnappliedBlueprint(path = BLUEPRINT_PATH) {
  const blueprint = readJsonFile(path, 'the blueprint');
  const validator = blueprint.validators?.find((v) => v.title === VALIDATOR_TITLE);
  if (validator === undefined) throw new UsageError(`the blueprint has no validator ${VALIDATOR_TITLE}`);
  const titles = (validator.parameters ?? []).map((p) => p.title);
  if (JSON.stringify(titles) !== JSON.stringify(PARAMETER_TITLES)) {
    throw new UsageError(
      `the blueprint's parameters are [${titles.join(', ')}], this tool applies [${PARAMETER_TITLES.join(', ')}]`,
    );
  }
  return { blueprint, validator };
}

// ---------------------------------------------------------------------------------------------
// params.json

const PARAM_KEYS = ['feeAddress', 'feeBps', 'minFeeLovelace', 'maxFeeLovelace'];

function whole(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** The fee address as its two credentials; it must be the shape the fee-address script makes. */
function checkFeeAddress(address, network) {
  if (typeof address !== 'string') throw new UsageError('feeAddress must be a bech32 address string');
  let details;
  try {
    details = getAddressDetails(address);
  } catch {
    throw new UsageError('feeAddress is not a valid Cardano address');
  }
  if (details.address.bech32 !== address) throw new UsageError('feeAddress must be a lowercase bech32 address');
  if (details.type !== 'Base') {
    throw new UsageError(
      `feeAddress must be a base address (a payment part and an inline stake part), not a ${details.type} address`,
    );
  }
  if (details.networkId !== NETWORKS[network].id) {
    throw new UsageError(`feeAddress is on the wrong network: the deployment is ${network}`);
  }
  if (details.paymentCredential?.type !== 'Script') {
    throw new UsageError('feeAddress payment part must be a script hash (the fee native script)');
  }
  if (details.stakeCredential?.type !== 'Key') {
    throw new UsageError('feeAddress stake part must be a stake key hash');
  }
  return { scriptHash: details.paymentCredential.hash, stakeKeyHash: details.stakeCredential.hash };
}

/**
 * Checks the contents of a params.json and returns them in the form the encoders take:
 * the fee address as its two hashes, the integers as BigInt, `maxFee` as BigInt or null.
 * Everything wrong is a UsageError that names the field.
 */
export function validateParams(params, network) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new UsageError('params must be a JSON object');
  }
  // OX Agent: Prototype Pollution prevented by rejecting every key but the four known ones and reading them with Object.hasOwn
  for (const key of Object.keys(params)) {
    if (!PARAM_KEYS.includes(key)) throw new UsageError(`params has an unknown field: ${key}`);
  }
  for (const key of PARAM_KEYS) {
    if (!Object.hasOwn(params, key)) {
      const hint = key === 'maxFeeLovelace' ? ' (use null for no cap)' : '';
      throw new UsageError(`params is missing ${key}${hint}`);
    }
  }

  const { feeAddress, feeBps, minFeeLovelace, maxFeeLovelace } = params;
  const { scriptHash, stakeKeyHash } = checkFeeAddress(feeAddress, network);

  if (!whole(feeBps) || feeBps <= 0 || feeBps >= 10000) {
    throw new UsageError('feeBps must be a whole number with 0 < feeBps < 10000');
  }
  if (feeBps > MAX_REVIEWED_FEE_BPS) {
    throw new UsageError(`feeBps must be at most ${MAX_REVIEWED_FEE_BPS} (the deployment review limit)`);
  }
  if (!whole(minFeeLovelace) || minFeeLovelace < 0) {
    throw new UsageError('minFeeLovelace must be a whole number of lovelace, 0 or more');
  }
  if (maxFeeLovelace !== null && (!whole(maxFeeLovelace) || maxFeeLovelace < minFeeLovelace)) {
    throw new UsageError('maxFeeLovelace must be null (no cap) or a whole number of lovelace of at least minFeeLovelace');
  }

  return {
    feeAddress,
    scriptHash,
    stakeKeyHash,
    feeBps: BigInt(feeBps),
    minFee: BigInt(minFeeLovelace),
    maxFee: maxFeeLovelace === null ? null : BigInt(maxFeeLovelace),
  };
}

// ---------------------------------------------------------------------------------------------
// fee-address.json

const FEE_ADDRESS_KEYS = ['nativeScript', 'scriptHash', 'address'];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** True when `value` is an object whose own keys are exactly `keys` (any order). */
function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Reads the native script of a fee address: exactly the shape fee-address.mjs makes,
 *
 *   all [ atLeast 2 of (sig a, sig b, sig c), after <slot> ]   with a < b < c as hex strings.
 *
 * Returns `{ slot }`, or `{ problem }` naming what differs. Nothing else is accepted, so
 * a record that was edited into a weaker script (one signer, no timelock) cannot pass.
 */
function readFeeNativeScript(script) {
  if (!hasExactKeys(script, ['type', 'scripts']) || script.type !== 'all' || !Array.isArray(script.scripts) || script.scripts.length !== 2) {
    return { problem: 'it is not `all` of exactly two scripts' };
  }
  const [threshold, timelock] = script.scripts;
  if (
    !hasExactKeys(threshold, ['type', 'required', 'scripts']) ||
    threshold.type !== 'atLeast' ||
    threshold.required !== 2 ||
    !Array.isArray(threshold.scripts) ||
    threshold.scripts.length !== 3
  ) {
    return { problem: 'the first script is not `atLeast` 2 of exactly three signers' };
  }
  const signers = threshold.scripts.map((signer) =>
    hasExactKeys(signer, ['type', 'keyHash']) && signer.type === 'sig' && typeof signer.keyHash === 'string' && KEY_HASH.test(signer.keyHash)
      ? signer.keyHash
      : null,
  );
  if (signers.includes(null)) return { problem: 'a signer is not `sig` with a key hash (56 lowercase hex characters)' };
  if (!(signers[0] < signers[1] && signers[1] < signers[2])) {
    return { problem: 'the signers are not three different key hashes in ascending order' };
  }
  if (!hasExactKeys(timelock, ['type', 'slot']) || timelock.type !== 'after' || !Number.isSafeInteger(timelock.slot)) {
    return { problem: 'the second script is not `after` a whole slot number' };
  }
  return { slot: timelock.slot };
}

/**
 * Checks the fee-address.json of a deployment against its version and its params.json, and
 * returns the problems found (an empty list when it is sound). It never throws on a bad record.
 *
 * The record is what fee-address.mjs printed: { nativeScript, scriptHash, address }. A deployment
 * is bound to it by four facts, each checked here without the parameter encoder:
 *
 *   1. the native script is the fee script, and its `after` slot is the version;
 *   2. the hash of that native script, derived again here, is `scriptHash`;
 *   3. `address` is the `feeAddress` of params.json, character for character;
 *   4. the address's payment credential is that script hash.
 *
 * `feeAddress` is the value from params.json and `version` the number of the deployment.
 */
export function feeAddressProblems(record, { version, feeAddress }) {
  // OX Agent: Prototype Pollution prevented by accepting only the three known own keys and reading them with Object.hasOwn
  if (!hasExactKeys(record, FEE_ADDRESS_KEYS)) {
    return [`fee-address.json must be the object fee-address.mjs prints, with exactly ${FEE_ADDRESS_KEYS.join(', ')}`];
  }
  const { nativeScript, scriptHash, address } = record;
  const problems = [];

  const script = readFeeNativeScript(nativeScript);
  if (script.problem !== undefined) {
    problems.push(`fee-address.json nativeScript is not the fee native script: ${script.problem}`);
  } else if (script.slot !== version) {
    problems.push(`fee-address.json nativeScript has after slot ${script.slot}, this deployment is version ${version}`);
  }

  if (typeof scriptHash !== 'string' || !KEY_HASH.test(scriptHash)) {
    problems.push('fee-address.json scriptHash is not a script hash (56 lowercase hex characters)');
  } else if (script.problem === undefined) {
    const derived = validatorToScriptHash(scriptFromNative(nativeScript));
    if (derived !== scriptHash) {
      problems.push(`fee-address.json scriptHash ${scriptHash} is not the hash of its nativeScript (${derived})`);
    }
  }

  if (typeof address !== 'string') {
    problems.push('fee-address.json address is not a string');
    return problems;
  }
  if (address !== feeAddress) {
    problems.push(`fee-address.json address ${address} is not params.json feeAddress ${feeAddress}`);
  }
  let payment;
  try {
    payment = getAddressDetails(address).paymentCredential;
  } catch {
    problems.push(`fee-address.json address ${address} is not a valid Cardano address`);
    return problems;
  }
  if (payment?.type !== 'Script' || payment.hash !== scriptHash) {
    problems.push(`fee-address.json address ${address} does not pay to its scriptHash (payment credential is ${payment?.type} ${payment?.hash})`);
  }
  return problems;
}
