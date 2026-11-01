// Whether a module is the script that `node` was started with, and not just imported.
//
// Each CLI script runs its `main` only when it is the entry point, so that a test can import its
// functions. The comparison has to use real paths on both sides: Node gives `import.meta.url` as
// the real path of the module, while `process.argv[1]` is the path as it was typed, which can go
// through a symlink (a linked checkout, a linked script). Comparing them as they are made a script
// started through a symlink do nothing and exit 0, which for a checking script reads as "passed".

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The real path of `path`; the plain absolute path when it cannot be resolved (it does not exist). */
function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `moduleUrl` (the module's `import.meta.url`) is the file `node` was started with.
 * `entryPoint` is `process.argv[1]`; without one (`node -e`, a REPL) nothing is main.
 */
export function isMain(moduleUrl, entryPoint = process.argv[1]) {
  if (entryPoint === undefined) return false;
  return realOrResolved(fileURLToPath(moduleUrl)) === realOrResolved(entryPoint);
}
