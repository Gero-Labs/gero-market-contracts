// Checks a deployment by applying its parameters a second time, with a different toolchain.
//
// Usage: node scripts/verify-params.mjs --network preprod|mainnet --version <N> [--dir <deployments folder>]
//
// apply-params.mjs encodes the parameters by hand and applies them with the Aiken CLI. This script
// reads the same `<dir>/<network>-v<N>/params.json`, builds the parameters as Plutus data with
// Lucid Evolution's own `Constr` (taking the two credentials of the fee address straight from the
// address bytes, not from apply-params' encoder), applies them to the committed, unapplied
// `plutus.json` with Lucid Evolution's `applyParamsToScript`, and hashes the result as a PlutusV3
// script. A parameter encoding mistake that still has a valid shape (the stake part as a pointer,
// a key hash where a script hash goes, max_fee as None) gives a valid script with another hash, so
// the two hashes only agree when both implementations got every parameter right. Lucid Evolution
// does no shape check at all, which is one more reason the encoding is compared and not trusted.
//
// It also checks `fee-address.json` (the output of fee-address.mjs for this version) against the
// version and params.json, without the parameter encoder: its native script is the fee script with
// the `after` slot equal to the version, that script hashes to its scriptHash, its address is
// params.json's feeAddress and pays to that script hash (lib/deployment.mjs, feeAddressProblems).
//
// Exit 0 only when all of these hold; otherwise exit 1 and the hashes (or the mismatch) are printed:
//   1. the re-applied script hashes to script.json's scriptHash;
//   2. script.json's compiledCode hashes to its own scriptHash;
//   3. plutus.json (the applied blueprint) holds that same code and hash;
//   4. fee-address.json matches the version and params.json as described above.
// A missing or unreadable file (fee-address.json included), or bad options, exits 2.

import { CML, Constr, applyParamsToScript, validatorToScriptHash } from '@lucid-evolution/lucid';

import {
  CheckFailure,
  DEFAULT_DEPLOYMENTS_DIR,
  UsageError,
  VALIDATOR_TITLE,
  deploymentPaths,
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

const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const hashOf = (script) => validatorToScriptHash({ type: 'PlutusV3', script });

/**
 * The fee address as Plutus data, read from the address bytes: a base address with a script
 * payment part (type 1: script, key) followed by the two 28-byte hashes.
 */
function feeAddressData(bech32) {
  const raw = CML.Address.from_bech32(bech32).to_raw_bytes();
  if (raw.length !== 57 || raw[0] >> 4 !== 1) {
    throw new UsageError('feeAddress is not a base address with a script payment part and a key stake part');
  }
  const paymentScriptHash = toHex(raw.slice(1, 29));
  const stakeKeyHash = toHex(raw.slice(29, 57));
  return new Constr(0, [
    new Constr(1, [paymentScriptHash]), // payment_credential: Script
    new Constr(0, [new Constr(0, [new Constr(0, [stakeKeyHash])])]), // Some(Inline(VerificationKey))
  ]);
}

/** The hash of the unapplied script, which must be the one Aiken put in the blueprint. */
function unappliedScript() {
  const { validator } = readUnappliedBlueprint();
  if (hashOf(validator.compiledCode) !== validator.hash) {
    throw new UsageError(
      `self-check failed: Lucid Evolution hashes the unapplied script to ${hashOf(validator.compiledCode)}, ` +
        `the blueprint says ${validator.hash}`,
    );
  }
  return validator.compiledCode;
}

function readScriptJson(path) {
  const script = readJsonFile(path, 'script.json');
  if (typeof script?.scriptHash !== 'string' || !/^[0-9a-f]{56}$/.test(script.scriptHash)) {
    throw new UsageError(`script.json (${path}) has no scriptHash of 56 lowercase hex characters`);
  }
  if (typeof script.compiledCode !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(script.compiledCode)) {
    throw new UsageError(`script.json (${path}) has no compiledCode in hex`);
  }
  return script;
}

function main() {
  const values = parseCli({
    network: { type: 'string' },
    version: { type: 'string' },
    dir: { type: 'string' },
  });
  const network = parseNetwork(requireOption(values, 'network'));
  const version = parseVersion(requireOption(values, 'version'));
  const paths = deploymentPaths(values.dir ?? DEFAULT_DEPLOYMENTS_DIR, network, version);

  const rawParams = readJsonFile(paths.params, 'params.json');
  validateParams(rawParams, network); // the same checks as apply-params; the values below come from the raw JSON
  const script = readScriptJson(paths.script);
  const deployed = readJsonFile(paths.plutus, 'plutus.json');
  const feeAddress = readJsonFile(paths.feeAddress, 'fee-address.json');

  const parameters = [
    feeAddressData(rawParams.feeAddress),
    BigInt(rawParams.feeBps),
    BigInt(rawParams.minFeeLovelace),
    rawParams.maxFeeLovelace === null ? new Constr(1, []) : new Constr(0, [BigInt(rawParams.maxFeeLovelace)]),
  ];
  const reapplied = hashOf(applyParamsToScript(unappliedScript(), parameters));

  const problems = [];
  if (reapplied !== script.scriptHash) {
    problems.push(
      'MISMATCH: the parameters give another script than script.json\n' +
        `  script.json scriptHash:             ${script.scriptHash}\n` +
        `  re-applied with Lucid Evolution:    ${reapplied}`,
    );
  }
  const ownHash = hashOf(script.compiledCode);
  if (ownHash !== script.scriptHash) {
    problems.push(
      'MISMATCH: script.json compiledCode does not hash to its scriptHash\n' +
        `  script.json scriptHash:             ${script.scriptHash}\n` +
        `  hash of script.json compiledCode:   ${ownHash}`,
    );
  }
  const spend = deployed.validators?.find((v) => v.title === VALIDATOR_TITLE);
  if (spend === undefined || spend.compiledCode !== script.compiledCode || spend.hash !== script.scriptHash) {
    problems.push(
      'MISMATCH: plutus.json does not hold the script of script.json\n' +
        `  script.json scriptHash:             ${script.scriptHash}\n` +
        `  plutus.json ${VALIDATOR_TITLE} hash: ${spend?.hash}`,
    );
  }
  // The fee address record must belong to this version and these params, whatever the encoders did.
  for (const problem of feeAddressProblems(feeAddress, { version, feeAddress: rawParams.feeAddress })) {
    problems.push(`MISMATCH: ${problem}`);
  }
  if (problems.length > 0) throw new CheckFailure(problems.join('\n'));

  console.log(
    `verified ${network}-v${version}: both implementations give script hash ${reapplied}\n` +
      `  script.json scriptHash:             ${script.scriptHash}\n` +
      `  re-applied with Lucid Evolution:    ${reapplied}`,
  );
}

if (isMain(import.meta.url)) runCli('verify-params', main);
