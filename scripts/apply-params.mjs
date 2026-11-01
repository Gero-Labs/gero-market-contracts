// Applies the four contract parameters to the compiled validator with the Aiken CLI.
//
// Usage: node scripts/apply-params.mjs --network preprod|mainnet --version <N> --params <params.json>
//          [--dir <deployments folder>]
//
// params.json: { "feeAddress": <bech32>, "feeBps": 100, "minFeeLovelace": 1500000,
//                "maxFeeLovelace": 5000000 | null }
//
// The deployment folder `<dir>/<network>-v<N>/` (default dir: deployments/) must already hold
// `fee-address.json`, the output of fee-address.mjs for this version. Before anything is applied
// it is checked against the version and the params (lib/deployment.mjs, feeAddressProblems): its
// native script is the fee script with the `after` slot equal to N, that script hashes to its
// scriptHash, its address is params.json's feeAddress and pays to that script hash. A mismatch
// exits 2. A folder that already holds `plutus.json` or `script.json` is a deployed one and is
// refused (exit 2), never overwritten.
//
// The committed, unapplied `plutus.json` is the input and is never changed. The parameters are
// applied one by one in declaration order (fee_address, fee_bps, min_fee, max_fee) with
// `aiken blueprint apply`, then `aiken blueprint hash` gives the script hash. The result is
// written to the deployment folder:
//
//   plutus.json   the blueprint with every parameter applied
//   script.json   { scriptHash, compiledCode }
//   params.json   a copy of the params that were applied (when --params is not that very file;
//                 a different params.json already in the folder is refused)
//
// The Plutus data of each parameter is encoded here, by hand, as CBOR. Aiken checks the shape of
// each parameter against the blueprint schema, which refuses a bare integer for max_fee, but a
// pointer in place of an inline stake credential, or a key hash in place of a script hash, is a
// valid shape and gives a valid script with another hash. So verify-params.mjs applies the same
// parameters again with Lucid Evolution, encoding them independently, and compares the hashes.
// Run it before anything is published.
//
// Prints { scriptHash, directory, parameters } as JSON, where `parameters` is the CBOR hex passed
// to aiken for each parameter. Exit 0 on success; bad input, or an Aiken that is missing or is not
// the version that built the blueprint, exits 2; hashes that disagree with each other exit 1.

import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import {
  BLUEPRINT_PATH,
  CheckFailure,
  DEFAULT_DEPLOYMENTS_DIR,
  PARAMETER_TITLES,
  ROOT,
  UsageError,
  VALIDATOR_TITLE,
  deploymentPaths,
  entryExists,
  feeAddressProblems,
  isMain,
  parseCli,
  parseNetwork,
  parseVersion,
  readJsonFile,
  readUnappliedBlueprint,
  requireOption,
  runCli,
  validateParams,
} from './lib/deployment.mjs';

// ---------------------------------------------------------------------------------------------
// Plutus data as CBOR

/** CBOR initial byte(s): a major type and an argument below 2^64, in the shortest form. */
function head(major, argument) {
  const tag = major << 5;
  const hexWidth = (bytes) => argument.toString(16).padStart(bytes * 2, '0');
  if (argument < 0n) throw new Error('negative integers are not needed here');
  if (argument < 24n) return (tag | Number(argument)).toString(16).padStart(2, '0');
  if (argument < 256n) return (tag | 24).toString(16) + hexWidth(1);
  if (argument < 65536n) return (tag | 25).toString(16) + hexWidth(2);
  if (argument < 2n ** 32n) return (tag | 26).toString(16) + hexWidth(4);
  if (argument < 2n ** 64n) return (tag | 27).toString(16) + hexWidth(8);
  throw new Error(`${argument} does not fit a CBOR integer of 64 bits`);
}

/** A non-negative integer (CBOR major type 0). */
const int = (n) => head(0, n);

/** A byte string given as hex (CBOR major type 2); Plutus data allows 64 bytes in one chunk. */
function bytes(hex) {
  if (!/^(?:[0-9a-f]{2}){0,64}$/.test(hex)) throw new Error('bytes must be 0 to 64 bytes of lowercase hex');
  return head(2, BigInt(hex.length / 2)) + hex;
}

/**
 * A constructor: tag 121 + index for the first seven, then its fields. Plutus writes the fields as
 * an indefinite-length list, or as the empty list when there are none.
 */
function constr(index, fields) {
  if (index > 6) throw new Error('constructor indices above 6 are not needed here');
  const tag = `d8${(0x79 + index).toString(16)}`;
  return fields.length === 0 ? `${tag}80` : `${tag}9f${fields.join('')}ff`;
}

/**
 * The CBOR of each parameter, keyed by the parameter's name in the blueprint.
 *
 *   fee_address  Address { payment_credential: Script(hash), stake_credential: Some(Inline(
 *                VerificationKey(stake key hash))) }
 *                = Constr 0 [Constr 1 [B scriptHash], Constr 0 [Constr 0 [Constr 0 [B stakeVkh]]]]
 *   fee_bps      Int
 *   min_fee      Int
 *   max_fee      Option<Int>: Some(n) = Constr 0 [I n], None = Constr 1 []
 *
 * `params` is what `validateParams` returns.
 */
export function encodeParams({ scriptHash, stakeKeyHash, feeBps, minFee, maxFee }) {
  const script = constr(1, [bytes(scriptHash)]); // Credential: Script
  const verificationKey = constr(0, [bytes(stakeKeyHash)]); // Credential: VerificationKey
  const inline = constr(0, [verificationKey]); // StakeCredential: Inline
  const some = constr(0, [inline]); // Option<StakeCredential>: Some
  return {
    fee_address: constr(0, [script, some]),
    fee_bps: int(feeBps),
    min_fee: int(minFee),
    max_fee: maxFee === null ? constr(1, []) : constr(0, [int(maxFee)]),
  };
}

// ---------------------------------------------------------------------------------------------
// Aiken

/** `aiken` with the given arguments, run without a shell, from the repo root. */
function aiken(args) {
  // OX Agent: Command Injection prevented by spawn with argument arrays, a fixed command and explicit allowlist validation
  const [first, second, third] = args;
  const isVersion = args.length === 1 && first === '--version';
  const isApply = first === 'blueprint' && second === 'apply' && /^[0-9a-f]+$/.test(third ?? ''); // CBOR hex, never an option
  const isHash = first === 'blueprint' && second === 'hash' && third === '--in';
  if (!isVersion && !isApply && !isHash) throw new Error(`aiken ${args.slice(0, 2).join(' ')} is not a command this script runs`);

  const result = spawnSync('aiken', args, { cwd: ROOT, encoding: 'utf8', shell: false, timeout: 120_000 });
  if (result.error) throw new UsageError(`aiken did not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new UsageError(`aiken ${args.slice(0, 2).join(' ')} failed (exit ${result.status}):\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

/** The Aiken on PATH must be the version that built the blueprint (its preamble names it). */
function requireBuildingAiken(blueprint) {
  const wanted = String(blueprint.preamble?.compiler?.version ?? '').split('+')[0]; // "v1.1.24"
  const reported = aiken(['--version']); // "aiken v1.1.24+bacbeb3"
  if (!/^v\d+\.\d+\.\d+$/.test(wanted) || reported.split('+')[0] !== `aiken ${wanted}`) {
    throw new UsageError(
      `aiken ${wanted} is needed (it built the blueprint), found "${reported}". ` +
        'Put the right one first on PATH; do not switch the default with aikup.',
    );
  }
}

const validatorsOf = (blueprint) => blueprint.validators.filter((v) => v.title.startsWith('listing.listing.'));

/**
 * Applies every parameter, in order, to a copy of the blueprint inside `workDir`. After each step
 * the validators must have exactly one parameter less. Returns the path of the last blueprint.
 */
function applyAll(parameterHex, workDir) {
  let current = BLUEPRINT_PATH;
  parameterHex.forEach((cbor, position) => {
    const next = join(workDir, `step-${position}.json`);
    aiken([
      'blueprint', 'apply', cbor,
      '--in', current,
      '--out', next,
      '--module', 'listing',
      '--validator', 'listing',
    ]);
    const expected = PARAMETER_TITLES.length - position - 1;
    for (const validator of validatorsOf(readJsonFile(next, `step ${position}`))) {
      const left = (validator.parameters ?? []).length;
      if (left !== expected) {
        throw new CheckFailure(`after parameter ${position + 1} ${validator.title} has ${left} parameters left, expected ${expected}`);
      }
    }
    current = next;
  });
  return current;
}

// ---------------------------------------------------------------------------------------------

/**
 * A deployed folder is never edited: one that holds plutus.json or script.json is refused, and so
 * is a params.json in it that differs from the one being applied.
 */
function refuseDeployedFolder(paths, paramsPath) {
  // OX Agent: Path Traversal prevented by naming only the fixed files of a folder deploymentPaths resolved inside --dir
  const present = [paths.plutus, paths.script].filter(entryExists).map((path) => basename(path));
  if (present.length > 0) {
    throw new UsageError(
      `${paths.folder} already contains ${present.join(' and ')}. A deployed folder is never edited: ` +
        'use the next version number and a new folder.',
    );
  }
  if (entryExists(paths.params) && resolve(paramsPath) !== paths.params) {
    const same = readFileSync(paramsPath).equals(readFileSync(paths.params));
    if (!same) {
      throw new UsageError(`${paths.params} already exists and differs from ${paramsPath}; apply the params that are in the folder`);
    }
  }
}

function main() {
  const values = parseCli({
    network: { type: 'string' },
    version: { type: 'string' },
    params: { type: 'string' },
    dir: { type: 'string' },
  });
  const network = parseNetwork(requireOption(values, 'network'));
  const version = parseVersion(requireOption(values, 'version'));
  const paramsPath = resolve(requireOption(values, 'params'));
  const paths = deploymentPaths(values.dir ?? DEFAULT_DEPLOYMENTS_DIR, network, version);

  const params = validateParams(readJsonFile(paramsPath, 'the params file'), network);

  // The fee address must belong to this version and these params before anything is written.
  const problems = feeAddressProblems(readJsonFile(paths.feeAddress, 'fee-address.json'), { version, feeAddress: params.feeAddress });
  if (problems.length > 0) throw new UsageError(problems.join('\n'));
  refuseDeployedFolder(paths, paramsPath);

  const encoded = encodeParams(params);
  const parameterHex = PARAMETER_TITLES.map((title) => encoded[title]);

  const { blueprint } = readUnappliedBlueprint();
  requireBuildingAiken(blueprint);

  const workDir = mkdtempSync(join(tmpdir(), 'gero-apply-params-'));
  try {
    const applied = applyAll(parameterHex, workDir);
    const scriptHash = aiken(['blueprint', 'hash', '--in', applied, '--module', 'listing', '--validator', 'listing']);
    const result = readJsonFile(applied, 'the applied blueprint');
    const spend = validatorsOf(result).find((v) => v.title === VALIDATOR_TITLE);
    if (!/^[0-9a-f]{56}$/.test(scriptHash)) throw new CheckFailure(`aiken printed "${scriptHash}", not a script hash`);
    for (const validator of validatorsOf(result)) {
      if (validator.hash !== scriptHash) {
        throw new CheckFailure(`${validator.title} hash ${validator.hash} differs from aiken's ${scriptHash}`);
      }
    }

    // 'wx' and COPYFILE_EXCL fail if the file appeared since the check above; nothing is overwritten.
    copyFileSync(applied, paths.plutus, constants.COPYFILE_EXCL);
    writeFileSync(paths.script, `${JSON.stringify({ scriptHash, compiledCode: spend.compiledCode }, null, 2)}\n`, { flag: 'wx' });
    if (resolve(paramsPath) !== paths.params && !entryExists(paths.params)) copyFileSync(paramsPath, paths.params, constants.COPYFILE_EXCL);

    const parameters = Object.fromEntries(PARAMETER_TITLES.map((title, i) => [title, parameterHex[i]]));
    console.log(JSON.stringify({ scriptHash, directory: paths.folder, parameters }, null, 2));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) runCli('apply-params', main);
