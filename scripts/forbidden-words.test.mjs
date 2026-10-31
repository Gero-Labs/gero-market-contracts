import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'forbidden-words.mjs');

// The word the rule forbids is assembled here so this file does not match the rule itself.
const WORD = String.fromCharCode(106, 112, 103);

const created = [];

/** A fresh git repo in a temp folder. Only files passed through `track` are visible to `git ls-files`. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'forbidden-words-'));
  created.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function track(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    execFileSync('git', ['add', '--', name], { cwd: dir });
  }
}

function run(dir) {
  const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let repo;
beforeEach(() => {
  repo = newRepo();
});

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

test('exits 1 and prints file:line for a tracked file with the forbidden word', () => {
  track(repo, { 'notes.txt': `first line\nsee the ${WORD} file\nlast line\n` });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `notes.txt:2: see the ${WORD} file\n`);
});

test('exits 0 with no output when every tracked file is clean', () => {
  track(repo, { 'notes.txt': 'nothing to see\n', 'sub/readme.md': 'also clean\n' });
  const result = run(repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('matches in any letter case and reports every hit, including nested files', () => {
  track(repo, {
    'a.txt': `${WORD.toUpperCase()} here\n`,
    'deep/b.txt': `clean\nMixed ${WORD[0].toUpperCase()}${WORD.slice(1)} case\n`,
  });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trimEnd().split('\n').sort(), [
    `a.txt:1: ${WORD.toUpperCase()} here`,
    `deep/b.txt:2: Mixed ${WORD[0].toUpperCase()}${WORD.slice(1)} case`,
  ]);
});

test('ignores integrity lines of package-lock.json but still checks its other lines', () => {
  track(repo, {
    'package-lock.json': `{\n  "packages": {\n    "node_modules/x": {\n      "integrity": "sha512-AB${WORD}CD=="\n    }\n  }\n}\n`,
  });
  assert.equal(run(repo).status, 0);

  const other = newRepo();
  track(other, { 'package-lock.json': `{\n  "name": "${WORD}-tool"\n}\n` });
  const result = run(other);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `package-lock.json:2:   "name": "${WORD}-tool"\n`);
});

test('does not exempt integrity lines in other files', () => {
  track(repo, { 'other.json': `{\n  "integrity": "sha512-AB${WORD}CD=="\n}\n` });
  const result = run(repo);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `other.json:2:   "integrity": "sha512-AB${WORD}CD=="\n`);
});
