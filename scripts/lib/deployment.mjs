// What fee-address.mjs, apply-params.mjs and verify-params.mjs have in common: reading and
// checking their input, the shape of a deployment folder, and the exit codes.
//
// Exit codes, as in the other scripts of this repo: 0 all good, 1 a check failed (a mismatch the
// script found), 2 bad input or a tool that could not run.
//
// Nothing here builds the Plutus data of the contract parameters. apply-params.mjs and
// verify-params.mjs each do that on their own, so that they stay two separate implementations.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { getAddressDetails } from '@lucid-evolution/lucid';

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
 * The version number is the `invalidBefore` slot of the fee address, which has to be in the past
 * for the fee address to be spendable. Both networks are far beyond this slot, so a version below
 * the cap is always satisfied and cannot lock the fees. A slip such as a date (20261101) is
 * refused instead of producing a fee address that nobody can spend from.
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

/** Runs `main`; turns a thrown UsageError, CheckFailure or any other error into an exit code. */
export function runCli(name, main) {
  try {
    main();
  } catch (error) {
    if (error instanceof CheckFailure) {
      console.log(error.message);
      process.exitCode = 1;
    } else {
      console.error(`${name}: ${error.message}`);
      process.exitCode = 2;
    }
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
    params: join(folder, 'params.json'),
    plutus: join(folder, 'plutus.json'),
    script: join(folder, 'script.json'),
  };
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
