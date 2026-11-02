// Runs verify-params.mjs on every committed deployment.
//
// Usage: node scripts/verify-deployments.mjs [--dir <deployments folder>]
//
// For every `<dir>/<network>-v<N>/` that holds a script.json (a deployment whose parameters have
// been applied), this runs `verify-params.mjs --network <network> --version <N> --dir <dir>`: the
// parameters applied a second time with Lucid Evolution must give the script hash of script.json,
// script.json and plutus.json must hold that script, and fee-address.json must belong to that
// version and those parameters. A folder without script.json is a deployment still being prepared
// and is left out. CI runs this, so a committed deployment folder that stops matching the source
// or its own records fails the build.
//
// A folder that has a deployment.json (a deployment that has been published) is checked once more:
// every field of it that repeats something the folder says (network, version, script hash, fee
// address, fee native script, parameters, Plutus and Aiken version) must say the same, and the
// fields only the chain or the operator know must have their shape (lib/deployment.mjs,
// deploymentRecordProblems). A folder with no deployment.json has not been published yet and is
// not asked for one.
//
// Every deployment is checked, even after one has failed. Exit 0 when all of them verify, 1 when
// any check found a mismatch, 2 on bad input (no deployment at all, a folder with a script.json
// that is not named <network>-v<N>, a file verify-params cannot read, a deployment.json that is not
// JSON). The worst result wins.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import {
  DEFAULT_DEPLOYMENTS_DIR,
  ROOT,
  UsageError,
  deploymentPaths,
  deploymentRecordProblems,
  entryExists,
  isMain,
  listDeployments,
  parseCli,
  readJsonFile,
  readScriptJson,
  runCli,
} from './lib/deployment.mjs';

const VERIFY_PARAMS = join(ROOT, 'scripts', 'verify-params.mjs');

const indent = (text) => text.replace(/^(?=.)/gm, '  ');

/**
 * Checks the deployment.json of a deployment folder against the folder's other files. Returns
 * `{ found: false }` for a folder with none, `{ found: true, problems }` otherwise (an empty list
 * when the record matches), and `{ found: true, unreadable }` when a file cannot be read.
 */
function checkRecord(dir, { network, version }) {
  // OX Agent: Path Traversal prevented by deploymentPaths, which resolves the folder inside --dir; the file names are fixed
  const paths = deploymentPaths(dir, network, version);
  if (!entryExists(paths.deployment)) return { found: false };
  try {
    const record = readJsonFile(paths.deployment, 'deployment.json');
    const problems = deploymentRecordProblems(record, {
      network,
      version,
      script: readScriptJson(paths.script),
      params: readJsonFile(paths.params, 'params.json'),
      feeAddress: readJsonFile(paths.feeAddress, 'fee-address.json'),
      plutus: readJsonFile(paths.plutus, 'plutus.json'),
    });
    return { found: true, problems, referenceScript: record?.referenceScript };
  } catch (error) {
    if (error instanceof UsageError) return { found: true, unreadable: error.message };
    throw error;
  }
}

function main() {
  const values = parseCli({ dir: { type: 'string' } });
  const dir = resolve(values.dir ?? DEFAULT_DEPLOYMENTS_DIR);
  const deployments = listDeployments(dir);

  let worst = 0;
  let failed = 0;
  for (const { name, network, version } of deployments) {
    // OX Agent: Command Injection prevented by an argument array with no shell, a fixed script, and a network and version already validated by listDeployments
    const result = spawnSync(
      process.execPath,
      [VERIFY_PARAMS, '--network', network, '--version', String(version), '--dir', dir],
      { encoding: 'utf8' },
    );
    const status = result.status ?? 2;
    let folderFailed = status !== 0;
    if (status === 0) {
      process.stdout.write(result.stdout);
    } else {
      console.log(`${name}: verify-params exited ${status}`);
      process.stdout.write(indent(result.stdout));
    }
    if (result.stderr) process.stderr.write(`${name}: ${result.stderr}`);
    if (result.error) process.stderr.write(`${name}: verify-params did not run: ${result.error.message}\n`);
    worst = Math.max(worst, status === 0 || status === 1 ? status : 2);

    // Its deployment.json, when it has one. Not when verify-params could not even read the folder.
    if (status === 0 || status === 1) {
      const record = checkRecord(dir, { network, version });
      if (record.unreadable !== undefined) {
        folderFailed = true;
        process.stderr.write(`${name}: ${record.unreadable}\n`);
        worst = 2;
      } else if (record.found && record.problems.length > 0) {
        folderFailed = true;
        console.log(`${name}: deployment.json does not match its folder`);
        console.log(indent(record.problems.map((problem) => `MISMATCH: ${problem}`).join('\n')));
        worst = Math.max(worst, 1);
      } else if (record.found) {
        console.log(`  ${name}: deployment.json matches the folder, reference script ${record.referenceScript}`);
      }
    }
    if (folderFailed) failed += 1;
  }

  const count = deployments.length;
  console.log(
    failed === 0
      ? `${count} deployment${count === 1 ? '' : 's'} verified`
      : `${failed} of ${count} deployment${count === 1 ? '' : 's'} failed`,
  );
  process.exitCode = worst;
}

if (isMain(import.meta.url)) runCli('verify-deployments', main);
