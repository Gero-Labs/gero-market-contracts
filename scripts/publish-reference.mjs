// Builds the unsigned transaction that publishes a deployed script as a reference script on preprod.
//
// Usage: node scripts/publish-reference.mjs --network preprod --version <N> --from <addr_test1...>
//          [--dir <deployments folder>]
//
// The script is `<dir>/preprod-v<N>/script.json` (default dir: deployments/), as written by
// apply-params.mjs. The transaction pays it as a PlutusV3 reference script to the always-fail
// address, the enterprise address of the native script `{"type":"any","scripts":[]}`. That script
// has no way to be satisfied, so the output can never be spent and the reference script stays
// where wallets and dApps can find it. The output has no datum and holds the minimum ADA the
// ledger requires for it; everything else comes back to `--from` as change. When what is left
// cannot hold a change output of its own (an address funded with just enough, such as the 10 tADA
// of the preprod deployer), there is no change output and the leftover is paid as fee, which
// Lucid Evolution's `includeLeftoverLovelaceAsFee` does. That lovelace would be lost either way (a
// locked output at the always-fail address is as unspendable as a fee), the leftover is smaller
// than the ledger's minimum for a change output, and the fee is capped at MAX_FEE_LOVELACE.
//
// Output: the unsigned transaction CBOR, as hex, on stdout and nothing else. A short summary
// (always-fail address, script hash, output lovelace, change, fee) goes to stderr. Exit 0 on success; bad
// input, an address with no funds, or a provider that cannot be reached exits 2.
//
// This script is preprod only: `--network` must be `preprod`, and mainnet or any other network is
// refused before any file is read or any provider is made. It reads no key file, holds no key and
// signs nothing: the person who owns `--from` signs the CBOR elsewhere. The only file it reads is
// script.json. UTxOs and protocol parameters come from the public Koios preprod endpoint (no API
// key); the provider is injectable (`makeLucid`) so the tests run against Lucid's Emulator.

import { CML, Lucid, getAddressDetails, scriptFromNative, validatorToAddress, validatorToScriptHash } from '@lucid-evolution/lucid';
import { Koios } from '@lucid-evolution/provider';

import {
  DEFAULT_DEPLOYMENTS_DIR,
  UsageError,
  deploymentPaths,
  isMain,
  parseCli,
  parseVersion,
  readScriptJson,
  requireOption,
  runCliAsync,
} from './lib/deployment.mjs';

/** The public Koios endpoint for preprod; no API key. */
export const KOIOS_PREPROD_URL = 'https://preprod.koios.rest/api/v1';

/**
 * The most the transaction may pay as fee. A publish costs about 0.25 ADA; with no change output
 * the leftover (always below the ledger minimum for an output, under 1 ADA) is added to it, so
 * anything above 1 ADA means the parameters or the wallet are not what the tool expects.
 */
export const MAX_FEE_LOVELACE = 1_000_000n;

/** A native script no transaction can satisfy: `any` of nothing. Its CBOR is `82 02 80`. */
export const ALWAYS_FAIL_SCRIPT = { type: 'any', scripts: [] };

/** The preprod enterprise address of the always-fail script (no stake part). */
export function alwaysFailAddress() {
  return validatorToAddress('Preprod', scriptFromNative(ALWAYS_FAIL_SCRIPT));
}

// ---------------------------------------------------------------------------------------------
// Input

/** `--from` must be a lowercase preprod base or enterprise address with a key payment part. */
function checkFrom(from) {
  if (typeof from !== 'string' || from === '') throw new UsageError('--from must be a preprod address (addr_test1...)');
  let details;
  try {
    details = getAddressDetails(from);
  } catch {
    throw new UsageError(`--from "${from}" is not a valid Cardano address`);
  }
  if (details.address.bech32 !== from) throw new UsageError('--from must be a lowercase bech32 address');
  if (details.networkId !== 0) throw new UsageError('--from must be a preprod address (addr_test1...), not a mainnet one');
  const spendable = (details.type === 'Base' || details.type === 'Enterprise') && details.paymentCredential?.type === 'Key';
  if (!spendable) {
    throw new UsageError(`--from must be a base or enterprise address with a key payment part, not a ${details.type} address`);
  }
}

const COMPILED_CODE = /^(?:[0-9a-f]{2})+$/;

// ---------------------------------------------------------------------------------------------
// The transaction

/**
 * Reads the built transaction back and checks it is exactly what was asked for; anything else is a
 * plain Error (nothing is printed). Returns what the summary reports: `changeLovelace` is what
 * goes back to `--from` (0 when the leftover was too small for a change output and went to the fee).
 */
function checkBuilt(txCbor, { from, scriptHash, coinsPerUtxoByte }) {
  const target = alwaysFailAddress();
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const problems = [];

  if (tx.witness_set().to_cbor_hex() !== 'a0') problems.push('it carries witnesses');
  if (tx.auxiliary_data() !== undefined) problems.push('it carries auxiliary data');
  for (const field of ['certs', 'withdrawals', 'mint', 'collateral_inputs', 'reference_inputs', 'script_data_hash']) {
    if (body[field]() !== undefined) problems.push(`it has ${field}`);
  }

  const outputs = body.outputs();
  let locked;
  let changeLovelace = 0n;
  for (let i = 0; i < outputs.len(); i += 1) {
    const output = outputs.get(i);
    const address = output.address().to_bech32();
    if (address === target) {
      if (locked !== undefined) problems.push('more than one output at the always-fail address');
      locked = output;
    } else if (address !== from || output.script_ref() !== undefined || output.datum() !== undefined) {
      problems.push(`an output to ${address} that is not plain change to --from`);
    } else {
      changeLovelace += output.amount().coin();
    }
  }
  if (body.fee() > MAX_FEE_LOVELACE) problems.push(`the fee is ${body.fee()} lovelace, more than ${MAX_FEE_LOVELACE}`);
  if (locked === undefined) {
    problems.push('no output at the always-fail address');
  } else {
    const reference = locked.script_ref();
    if (reference === undefined || reference.kind() !== 3 || reference.hash().to_hex() !== scriptHash) {
      problems.push('the output at the always-fail address does not hold the PlutusV3 script as its reference script');
    }
    if (locked.datum() !== undefined) problems.push('the output at the always-fail address has a datum');
    if (locked.amount().multi_asset().keys().len() !== 0) problems.push('the output at the always-fail address holds tokens');
    const minimum = BigInt(160 + locked.to_cbor_bytes().length) * coinsPerUtxoByte;
    if (locked.amount().coin() < minimum) problems.push(`the output holds ${locked.amount().coin()} lovelace, the ledger needs ${minimum}`);
  }
  if (problems.length > 0) throw new Error(`the built transaction is not what was asked for: ${problems.join('; ')}`);

  return { alwaysFailAddress: target, scriptHash, outputLovelace: locked.amount().coin(), changeLovelace, fee: body.fee() };
}

/**
 * Builds the unsigned publish transaction against `lucid` (a Lucid Evolution instance on Preprod
 * with any provider). `compiledCode` is the script's hex as in script.json, `from` the address that
 * pays. Returns `{ txCbor, alwaysFailAddress, scriptHash, outputLovelace, changeLovelace, fee }`.
 */
export async function buildPublishTx({ lucid, compiledCode, from }) {
  checkFrom(from);
  if (typeof compiledCode !== 'string' || !COMPILED_CODE.test(compiledCode)) {
    throw new UsageError('the script (compiledCode) must be hex');
  }
  const script = { type: 'PlutusV3', script: compiledCode };
  const scriptHash = validatorToScriptHash(script);

  const utxos = await lucid.utxosAt(from);
  if (utxos.length === 0) throw new UsageError(`no UTxOs at ${from} on preprod: fund it from the faucet first`);
  lucid.selectWallet.fromAddress(from, utxos);

  let txCbor;
  try {
    // `includeLeftoverLovelaceAsFee`: with too little left for a change output, pay it as fee
    // instead of failing; checkBuilt caps the fee.
    const built = await lucid
      .newTx()
      .pay.ToAddressWithData(alwaysFailAddress(), undefined, {}, script)
      .complete({ includeLeftoverLovelaceAsFee: true });
    txCbor = built.toCBOR();
  } catch (error) {
    throw new UsageError(`cannot build the transaction (does ${from} hold enough ADA?): ${error?.message ?? error}`);
  }
  const { coinsPerUtxoByte } = lucid.config().protocolParameters;
  return { txCbor, ...checkBuilt(txCbor, { from, scriptHash, coinsPerUtxoByte }) };
}

/** The summary printed on stderr. */
export function formatSummary({ alwaysFailAddress: address, scriptHash, outputLovelace, changeLovelace, fee }) {
  const lines = [
    `always-fail address: ${address}`,
    `script hash:         ${scriptHash}`,
    `output lovelace:     ${outputLovelace}`,
    `change lovelace:     ${changeLovelace}`,
    `fee (lovelace):      ${fee}`,
  ];
  if (changeLovelace === 0n) {
    lines.push('note: no change output; the lovelace left over (too little for one) is part of the fee');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// From a deployment folder

/** A Lucid Evolution instance on preprod that reads from the public Koios endpoint. */
async function makeKoiosLucid() {
  try {
    return await Lucid(new Koios(KOIOS_PREPROD_URL), 'Preprod');
  } catch (error) {
    throw new UsageError(`cannot reach Koios (${KOIOS_PREPROD_URL}): ${error?.message ?? error}`);
  }
}

/**
 * Builds the publish transaction for `preprod-v<version>` of the deployments folder `dir`.
 * `makeLucid` returns a Lucid Evolution instance; the default reads from Koios, tests pass an
 * Emulator. The order matters: the network is refused first, then the folder is read, then `--from`
 * is checked, and only then is a provider made.
 */
export async function publishReference({ network, version, from, dir = DEFAULT_DEPLOYMENTS_DIR, makeLucid = makeKoiosLucid }) {
  // OX Agent: Authorization prevented by refusing every network but preprod before any file or provider is touched
  if (network !== 'preprod') {
    throw new UsageError(`--network "${network}" is refused: this script publishes to preprod only`);
  }
  const paths = deploymentPaths(dir, 'preprod', parseVersion(String(version)));
  const script = readScriptJson(paths.script);
  if (validatorToScriptHash({ type: 'PlutusV3', script: script.compiledCode }) !== script.scriptHash) {
    throw new UsageError(`script.json (${paths.script}) has a scriptHash that is not the hash of its compiledCode`);
  }
  checkFrom(from);
  const lucid = await makeLucid('preprod');
  return buildPublishTx({ lucid, compiledCode: script.compiledCode, from });
}

async function main() {
  const values = parseCli({
    network: { type: 'string' },
    version: { type: 'string' },
    from: { type: 'string' },
    dir: { type: 'string' },
  });
  const built = await publishReference({
    network: requireOption(values, 'network'),
    version: requireOption(values, 'version'),
    from: requireOption(values, 'from'),
    dir: values.dir,
  });
  process.stdout.write(`${built.txCbor}\n`);
  process.stderr.write(`${formatSummary(built)}\n`);
}

if (isMain(import.meta.url)) await runCliAsync('publish-reference', main);
