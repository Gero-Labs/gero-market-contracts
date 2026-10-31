// Fails when a tracked file contains a word this repo must never carry.
//
// Usage: node scripts/forbidden-words.mjs [directory]
//
// Reads `git ls-files` in the directory (default: the current one) and checks every line of
// every tracked file, ignoring case. Prints `file:line: <text>` for each hit and exits 1 if
// there is any, otherwise prints nothing and exits 0. A failure to list or read files exits 2.
//
// The one exemption: `"integrity":` lines of package-lock.json, because those hold random
// base64 that can contain any three letters by chance. Nothing a person writes sits there.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

// Built from character codes so that this file does not match its own rule.
const FORBIDDEN = new RegExp(String.fromCharCode(106, 112, 103), 'i');

const LOCKFILE = 'package-lock.json';
const INTEGRITY_LINE = /"integrity":/;

function trackedFiles(dir) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function readTextFile(path) {
  try {
    // Symlinks, directories (submodules) and files deleted from the work tree hold no text of ours.
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function findHits(dir) {
  const hits = [];
  for (const file of trackedFiles(dir)) {
    const text = readTextFile(join(dir, file));
    if (text === null) continue;
    const isLockfile = basename(file) === LOCKFILE;
    text.split(/\r?\n/).forEach((line, index) => {
      if (isLockfile && INTEGRITY_LINE.test(line)) return;
      if (FORBIDDEN.test(line)) hits.push(`${file}:${index + 1}: ${line}`);
    });
  }
  return hits;
}

try {
  const hits = findHits(resolve(process.argv[2] ?? '.'));
  if (hits.length > 0) {
    console.log(hits.join('\n'));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`forbidden-words: ${error.message}`);
  process.exitCode = 2;
}
