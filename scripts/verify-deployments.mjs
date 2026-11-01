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
// Every deployment is checked, even after one has failed. Exit 0 when all of them verify, 1 when
// any check found a mismatch, 2 on bad input (no deployment at all, a folder with a script.json
// that is not named <network>-v<N>, a file verify-params cannot read). The worst result wins.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { DEFAULT_DEPLOYMENTS_DIR, ROOT, isMain, listDeployments, parseCli, runCli } from './lib/deployment.mjs';

const VERIFY_PARAMS = join(ROOT, 'scripts', 'verify-params.mjs');

const indent = (text) => text.replace(/^(?=.)/gm, '  ');

function main() {
  const values = parseCli({ dir: { type: 'string' } });
  const dir = resolve(values.dir ?? DEFAULT_DEPLOYMENTS_DIR);
  const deployments = listDeployments(dir);

  let worst = 0;
  let failed = 0;
  for (const { name, network, version } of deployments) {
    const result = spawnSync(
      process.execPath,
      [VERIFY_PARAMS, '--network', network, '--version', String(version), '--dir', dir],
      { encoding: 'utf8' },
    );
    const status = result.status ?? 2;
    if (status === 0) {
      process.stdout.write(result.stdout);
    } else {
      failed += 1;
      console.log(`${name}: verify-params exited ${status}`);
      process.stdout.write(indent(result.stdout));
    }
    if (result.stderr) process.stderr.write(`${name}: ${result.stderr}`);
    if (result.error) process.stderr.write(`${name}: verify-params did not run: ${result.error.message}\n`);
    worst = Math.max(worst, status === 0 || status === 1 ? status : 2);
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
