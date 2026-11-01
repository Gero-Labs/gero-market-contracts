// Runs the compiled, applied script of every deployment on committed script contexts.
//
// Usage: node scripts/eval-applied.mjs [--dir <deployments folder>] [--contexts <contexts folder>]
//          [--tests <Aiken test file>]
//
// Defaults (relative to the repository root, whatever the current folder is):
//   --dir      deployments
//   --contexts test-vectors/contexts
//   --tests    lib/gero_market/contexts.test.ak
//
// The Aiken tests call the validator as a function. This script runs what goes on chain instead:
// `compiledCode` of `<dir>/<network>-v<N>/script.json`, the script with its four parameters
// applied, through Aiken's own UPLC evaluator, with the data the ledger would hand it.
//
// For every deployment folder that holds a script.json, `<contexts>/<network>-v<N>/` must hold
// exactly one `<name>.hex` for each name in EXPECTED: the CBOR of a Plutus V3 script context,
// `cbor.serialise` of a context that lib/gero_market/contexts.ak builds. Before anything runs, each
// file is checked:
//   1. the Aiken test `<network>_v<N>_<name>` of --tests pins exactly these bytes, so the file
//      cannot drift from the code that builds it;
//   2. it is tied to this deployment: the input it spends sits at the deployment's script hash
//      (script.json), and a purchase pays an output to the deployment's fee address (params.json).
//      The amounts in the contexts are those of the version 1 terms, so a deployment with other
//      terms shows up as a verdict that is not the expected one.
// Then `aiken uplc eval` (Aiken v1.1.24 first on PATH) applies the script to each context, as Plutus
// V3 does, and the verdict is compared with EXPECTED. Success is the unit value; the memory and CPU
// units it took are printed (the single-buy figures of docs/budget.md come from here). Failure is
// an evaluation error, whose first line is printed.
//
// Exit 0 when every verdict is the expected one. Exit 1 when a verdict differs or a check above
// fails, with the findings on stdout. Exit 2 on bad options, a file that cannot be read, a badly
// named deployment folder, no deployment at all, or an Aiken that is missing, is not v1.1.24 or
// answers in a way this script does not understand.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { getAddressDetails } from '@lucid-evolution/lucid';

import {
  CheckFailure,
  DEFAULT_DEPLOYMENTS_DIR,
  ROOT,
  UsageError,
  entryExists,
  isMain,
  listDeployments,
  parseCli,
  readJsonFile,
  readScriptJson,
  runCli,
  validateParams,
} from './lib/deployment.mjs';

export const DEFAULT_CONTEXTS_DIR = join(ROOT, 'test-vectors', 'contexts');
export const DEFAULT_TESTS = join(ROOT, 'lib', 'gero_market', 'contexts.test.ak');

/** The contexts every deployment must have, and what its applied script must do with each. */
export const EXPECTED = Object.freeze({
  purchase_ok: 'success',
  purchase_no_royalty: 'success',
  purchase_three_royalties: 'success',
  purchase_fee_short: 'failure',
  cancel_ok: 'success',
  cancel_no_datum: 'failure',
  cancel_bad_datum: 'failure',
  // A datum that is a constructor but not a `Listing` (a Listing with a sixth field). A cancel reads
  // only the owner in field 0, so the key in that field can still cancel; a purchase checks the whole
  // shape of every datum at the script, so it fails.
  cancel_constr_datum: 'success',
  cancel_constr_datum_unsigned: 'failure',
  purchase_constr_datum: 'failure',
});

const AIKEN_VERSION = /^aiken v1\.1\.24\b/;
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/;
const UNIT = '(con unit ())';

// ---------------------------------------------------------------------------------------------
// CBOR to Plutus data, and Plutus data as UPLC text

/**
 * Decodes the CBOR of one Plutus data value into `{ constr, fields }`, `{ list }`, `{ map }` (a list
 * of `[key, value]`), `{ int }` (a BigInt) or `{ bytes }` (hex). Definite and indefinite lengths are
 * both read, as are the big-integer tags. Anything that is not Plutus data (text, floats, other
 * tags), a cut-off item or bytes left over is an error.
 */
export function decodeData(bytes) {
  let at = 0;
  const take = (n) => {
    if (at + n > bytes.length) throw new Error(`the CBOR is cut off at byte ${bytes.length}`);
    const slice = bytes.subarray(at, at + n);
    at += n;
    return slice;
  };
  const toBigInt = (slice) => slice.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  const argument = (info) => {
    if (info < 24) return BigInt(info);
    if (info === 24) return toBigInt(take(1));
    if (info === 25) return toBigInt(take(2));
    if (info === 26) return toBigInt(take(4));
    if (info === 27) return toBigInt(take(8));
    throw new Error(`unsupported CBOR length ${info} at byte ${at - 1}`);
  };
  const count = (info) => {
    const n = argument(info);
    if (n > BigInt(bytes.length)) throw new Error(`a length of ${n} cannot fit in ${bytes.length} bytes`);
    return Number(n);
  };
  const isBreak = () => {
    if (at >= bytes.length) throw new Error(`the CBOR is cut off at byte ${bytes.length}`);
    if (bytes[at] !== 0xff) return false;
    at += 1;
    return true;
  };

  function item() {
    const [initial] = take(1);
    const major = initial >> 5;
    const info = initial & 31;
    const indefinite = info === 31;
    if (indefinite && ![2, 4, 5].includes(major)) throw new Error(`unexpected indefinite or break byte at ${at - 1}`);
    switch (major) {
      case 0:
        return { int: argument(info) };
      case 1:
        return { int: -1n - argument(info) };
      case 2: {
        if (!indefinite) return { bytes: Buffer.from(take(count(info))).toString('hex') };
        let hex = '';
        while (!isBreak()) {
          const [chunk] = take(1);
          if (chunk >> 5 !== 2 || (chunk & 31) === 31) throw new Error(`a byte string chunk is not a byte string at ${at - 1}`);
          hex += Buffer.from(take(count(chunk & 31))).toString('hex');
        }
        return { bytes: hex };
      }
      case 4: {
        const list = [];
        if (indefinite) while (!isBreak()) list.push(item());
        else for (let n = count(info); n > 0; n--) list.push(item());
        return { list };
      }
      case 5: {
        const map = [];
        if (indefinite) while (!isBreak()) map.push([item(), item()]);
        else for (let n = count(info); n > 0; n--) map.push([item(), item()]);
        return { map };
      }
      case 6:
        return tagged(argument(info));
      default:
        throw new Error(`CBOR major type ${major} at byte ${at - 1} is not Plutus data`);
    }
  }

  function tagged(tag) {
    const fieldsOf = (value) => {
      if (value.list === undefined) throw new Error(`the fields of constructor tag ${tag} are not a list`);
      return value.list;
    };
    if (tag >= 121n && tag <= 127n) return { constr: Number(tag - 121n), fields: fieldsOf(item()) };
    if (tag >= 1280n && tag <= 1400n) return { constr: Number(tag - 1280n) + 7, fields: fieldsOf(item()) };
    if (tag === 102n) {
      const pair = fieldsOf(item());
      if (pair.length !== 2 || pair[0].int === undefined || pair[1].list === undefined) {
        throw new Error('tag 102 does not hold [constructor index, fields]');
      }
      return { constr: Number(pair[0].int), fields: pair[1].list };
    }
    if (tag === 2n || tag === 3n) {
      const value = item();
      if (value.bytes === undefined) throw new Error(`big integer tag ${tag} does not hold a byte string`);
      const magnitude = value.bytes === '' ? 0n : BigInt(`0x${value.bytes}`);
      return { int: tag === 2n ? magnitude : -1n - magnitude };
    }
    throw new Error(`CBOR tag ${tag} is not Plutus data`);
  }

  const value = item();
  if (at !== bytes.length) throw new Error(`${bytes.length - at} bytes left after the data`);
  return value;
}

/** Plutus data in the textual form `aiken uplc eval` reads inside `(con data (...))`. */
export function toUplcData(data) {
  if (data.constr !== undefined) return `Constr ${data.constr} [${data.fields.map(toUplcData).join(', ')}]`;
  if (data.list !== undefined) return `List [${data.list.map(toUplcData).join(', ')}]`;
  if (data.map !== undefined) {
    return `Map [${data.map.map(([key, value]) => `(${toUplcData(key)}, ${toUplcData(value)})`).join(', ')}]`;
  }
  if (data.int !== undefined) return `I ${data.int}`;
  return `B #${data.bytes}`;
}

// ---------------------------------------------------------------------------------------------
// The checks before evaluating

/**
 * The bytes the Aiken test `name` pins: the one `#"<hex>"` literal in its body, `//` comments left
 * out. Undefined when there is no such test or it does not hold exactly one literal.
 */
export function pinnedHex(source, name) {
  const code = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const escaped = name.replace(/[^a-z0-9_]/gi, (c) => `\\${c}`);
  const test = new RegExp(`(?:^|\\n)\\s*test\\s+${escaped}\\s*\\(\\)\\s*\\{([^}]*)\\}`).exec(code);
  if (test === null) return undefined;
  const literals = [...test[1].matchAll(/#"([0-9a-f]*)"/g)];
  return literals.length === 1 ? literals[0][1] : undefined;
}

const sameData = (a, b) => toUplcData(a) === toUplcData(b);
const constrOf = (index, ...fields) => ({ constr: index, fields });
const field = (data, index) => (data?.constr !== undefined ? data.fields[index] : undefined);

/** A base address with a script payment part and a key stake part, as Plutus data. */
function feeAddressData(bech32) {
  const { paymentCredential, stakeCredential } = getAddressDetails(bech32);
  return constrOf(
    0,
    constrOf(1, { bytes: paymentCredential.hash }),
    constrOf(0, constrOf(0, constrOf(0, { bytes: stakeCredential.hash }))),
  );
}

/**
 * What ties the script context `context` (decoded data) called `name` to a deployment, as a list of
 * problems (empty when it is tied): its spent input sits at `scriptHash`, and a purchase pays an
 * output to `feeAddress` (bech32).
 */
export function contextProblems(name, context, { scriptHash, feeAddress }) {
  const transaction = field(context, 0);
  const purpose = field(context, 2);
  const inputs = field(transaction, 0)?.list;
  const outputs = field(transaction, 2)?.list;
  if (context?.constr !== 0 || purpose?.constr !== 1 || inputs === undefined || outputs === undefined) {
    return ['not a script context for spending'];
  }
  const ownRef = field(purpose, 0);
  const spent = inputs.find((input) => sameData(field(input, 0), ownRef));
  if (spent === undefined) return ['the reference it spends is not among its inputs'];

  const problems = [];
  const payment = field(field(field(spent, 1), 0), 0);
  if (!sameData(payment ?? {}, constrOf(1, { bytes: scriptHash }))) {
    problems.push(`the input it spends is not at the deployment's script hash ${scriptHash}`);
  }
  if (name.startsWith('purchase')) {
    const fee = feeAddressData(feeAddress);
    if (!outputs.some((output) => sameData(field(output, 0) ?? {}, fee))) {
      problems.push(`a purchase with no output at the deployment's fee address ${feeAddress}`);
    }
  }
  return problems;
}

/** The contexts of one deployment, checked, ready to evaluate; findings go into `problems`. */
function contextsOf(deployment, contextsDir, testSource, testsPath, problems) {
  const script = readScriptJson(join(deployment.folder, 'script.json'));
  const params = readJsonFile(join(deployment.folder, 'params.json'), 'params.json');
  validateParams(params, deployment.network);

  const folder = join(contextsDir, deployment.name);
  if (!entryExists(folder)) {
    problems.push(`${deployment.name}: no script contexts; add ${folder} (see docs/deploying.md)`);
    return [];
  }
  let files;
  try {
    files = readdirSync(folder).filter((file) => file.endsWith('.hex'));
  } catch (error) {
    throw new UsageError(`cannot read ${folder}: ${error.message}`);
  }
  for (const file of files) {
    if (!Object.hasOwn(EXPECTED, file.slice(0, -'.hex'.length))) {
      problems.push(`${deployment.name}: ${file}: no expected verdict for this context in scripts/eval-applied.mjs`);
    }
  }

  const ready = [];
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const at = `${deployment.name}: ${name}`;
    const file = join(folder, `${name}.hex`);
    if (!files.includes(`${name}.hex`)) {
      problems.push(`${deployment.name}: ${name}.hex is missing`);
      continue;
    }
    let hex;
    try {
      hex = readFileSync(file, 'utf8').trim();
    } catch (error) {
      throw new UsageError(`cannot read ${file}: ${error.message}`);
    }
    if (!HEX_BYTES.test(hex)) {
      problems.push(`${deployment.name}: ${name}.hex does not hold lowercase hex bytes`);
      continue;
    }
    const testName = `${deployment.name.replace('-', '_')}_${name}`;
    if (pinnedHex(testSource, testName) !== hex) {
      problems.push(`${deployment.name}: ${name}.hex is not the bytes pinned by test ${testName} in ${testsPath}`);
      continue;
    }
    let context;
    try {
      context = decodeData(Buffer.from(hex, 'hex'));
    } catch (error) {
      problems.push(`${at}: not Plutus data: ${error.message}`);
      continue;
    }
    for (const problem of contextProblems(name, context, { scriptHash: script.scriptHash, feeAddress: params.feeAddress })) {
      problems.push(`${at}: ${problem}`);
    }
    ready.push({ deployment: deployment.name, name, expected, argument: `(con data (${toUplcData(context)}))` });
  }
  return [{ deployment, compiledCode: script.compiledCode, contexts: ready }];
}

// ---------------------------------------------------------------------------------------------
// Evaluating

function requireAiken() {
  const result = spawnSync('aiken', ['--version'], { encoding: 'utf8' });
  if (result.error) throw new UsageError(`needs aiken v1.1.24 first on PATH; aiken did not run: ${result.error.message}`);
  const line = result.stdout.trim();
  if (!AIKEN_VERSION.test(line)) throw new UsageError(`needs aiken v1.1.24 first on PATH, found "${line}"`);
}

/** Applies the script in `scriptFile` (CBOR hex) to `argument` with `aiken uplc eval`. */
function evaluate(scriptFile, argument) {
  const result = spawnSync('aiken', ['uplc', 'eval', '--cbor', scriptFile, argument], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new UsageError(`aiken uplc eval did not run: ${result.error.message}`);
  if (result.status === 0) {
    let answer;
    try {
      answer = JSON.parse(result.stdout);
    } catch {
      throw new UsageError(`aiken uplc eval printed something that is not JSON:\n${result.stdout}`);
    }
    if (!Number.isSafeInteger(answer?.mem) || !Number.isSafeInteger(answer?.cpu) || typeof answer.result !== 'string') {
      throw new UsageError(`aiken uplc eval printed no result, mem and cpu:\n${result.stdout}`);
    }
    if (answer.result === UNIT) return { verdict: 'success', mem: answer.mem, cpu: answer.cpu };
    return { verdict: 'failure', why: `returned ${answer.result}, not unit` };
  }
  const error = /^\s*Error\n-+\n+([^\n]+)/.exec(result.stderr);
  const costs = /\nCosts\n-+\ncpu: \d+\nmemory: \d+/.test(result.stderr);
  if (result.status === 1 && error !== null && costs) return { verdict: 'failure', why: error[1].trim() };
  throw new UsageError(`aiken uplc eval failed without evaluating the script (exit ${result.status}):\n${result.stderr.trim()}`);
}

const units = (n) => (n === undefined ? '-' : n.toLocaleString('en-US'));

function table(rows) {
  const header = ['deployment', 'context', 'expected', 'verdict', 'memory', 'cpu', 'error'];
  const cells = rows.map((r) => [r.deployment, r.name, r.expected, r.verdict, units(r.mem), units(r.cpu), r.why ?? '']);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((cell, i) => cell.padEnd(widths[i])).join(' | ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('-+-'), ...cells.map(line)].join('\n');
}

function main() {
  const values = parseCli({
    dir: { type: 'string' },
    contexts: { type: 'string' },
    tests: { type: 'string' },
  });
  const contextsDir = resolve(values.contexts ?? DEFAULT_CONTEXTS_DIR);
  const testsPath = resolve(values.tests ?? DEFAULT_TESTS);
  const deployments = listDeployments(values.dir ?? DEFAULT_DEPLOYMENTS_DIR);
  let testSource;
  try {
    testSource = readFileSync(testsPath, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read the pin tests (${testsPath}): ${error.message}`);
  }

  const problems = [];
  const plans = deployments.flatMap((deployment) => contextsOf(deployment, contextsDir, testSource, testsPath, problems));
  if (problems.length > 0) throw new CheckFailure(problems.map((problem) => `MISMATCH: ${problem}`).join('\n'));

  requireAiken();
  const rows = [];
  for (const { compiledCode, contexts } of plans) {
    const dir = mkdtempSync(join(tmpdir(), 'eval-applied-'));
    try {
      const scriptFile = join(dir, 'script.hex');
      writeFileSync(scriptFile, compiledCode);
      for (const context of contexts) rows.push({ ...context, ...evaluate(scriptFile, context.argument) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const unexpected = rows.filter((row) => row.verdict !== row.expected);
  console.log(table(rows));
  console.log(
    `\n${rows.length} contexts on ${plans.length} deployment${plans.length === 1 ? '' : 's'}: ` +
      `${rows.length - unexpected.length} as expected, ${unexpected.length} unexpected`,
  );
  if (unexpected.length > 0) {
    for (const row of unexpected) {
      console.log(`UNEXPECTED: ${row.deployment} ${row.name}: expected ${row.expected}, got ${row.verdict}`);
    }
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) runCli('eval-applied', main);
