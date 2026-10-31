import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findMarkers, judge, parseClause } from './mutation-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'mutation-check.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AIKEN = process.env.AIKEN || 'aiken';

/** Why the tests that run a real aiken cannot run here, or false when they can. */
function aikenProblem() {
  const found = spawnSync(AIKEN, ['--version'], { encoding: 'utf8' });
  if (found.status !== 0) return 'aiken is not on PATH (set AIKEN or add it to PATH)';
  // Other versions are not trusted to judge a mutant: the project pins its compiler.
  const pinned = /^compiler\s*=\s*"(v[^"]+)"/m.exec(readFileSync(join(ROOT, 'aiken.toml'), 'utf8'))?.[1];
  if (pinned && !found.stdout.includes(`aiken ${pinned}`)) {
    return `aiken ${pinned} is needed, found ${found.stdout.trim()}`;
  }
  return false;
}
const NEEDS_AIKEN = aikenProblem();

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder holding `files` (path to text). */
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-check-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A small Aiken project with no dependencies, so nothing is downloaded. */
function project(files) {
  return folder({
    'aiken.toml': 'name = "demo/mutants"\nversion = "0.0.0"\nplutus = "v3"\n',
    ...files,
  });
}

/** A stand-in for aiken: succeeds at once the first `fast` times, then waits for 30 s. */
function fakeAiken(dir, fast) {
  const path = join(dir, 'fake-aiken.sh');
  writeFileSync(
    path,
    `#!/bin/sh\nn=$(cat "${dir}/count" 2>/dev/null || echo 0)\necho $((n + 1)) > "${dir}/count"\n` +
      `if [ "$n" -ge ${fast} ]; then exec sleep 30; fi\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A stand-in for aiken that ends its n-th run as `steps[n]` says: a number is an exit status,
 * `'kill'` makes it die by SIGKILL. The runs of a one-marker project are, in order: the check of
 * the untouched project, the compile run and the tests run of the mutant.
 */
function scriptedAiken(dir, steps) {
  const path = join(dir, 'scripted-aiken.sh');
  const cases = steps
    .map((step, n) => `  ${n}) ${step === 'kill' ? 'kill -9 $$' : `exit ${step}`} ;;`)
    .join('\n');
  writeFileSync(
    path,
    `#!/bin/sh\nn=$(cat "${dir}/count" 2>/dev/null || echo 0)\necho $((n + 1)) > "${dir}/count"\n` +
      `case $n in\n${cases}\n  *) exit 0 ;;\nesac\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function run(root, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The `status` column of the table row for `id`, or undefined. */
function statusOf(stdout, id) {
  const row = stdout.split('\n').find((line) => line.startsWith(`${id} `));
  return row?.split('|').at(-1).trim();
}

const RULES = `pub fn both(a: Bool, b: Bool) -> Bool {
  and {
    // mutant:needs-a
    a,
    // mutant:ignored-b
    b,
  }
}
`;

// Every test expects both(False, True) to be False, so replacing a by True is noticed.
// No test passes False for b, so replacing b by True goes unnoticed.
const RULES_TESTS = `use demo/rules

test needs_a() {
  !rules.both(False, True)
}

test both_true() {
  rules.both(True, True)
}
`;

test('a surviving mutant is named, the others are killed, the exit code is 1', { skip: NEEDS_AIKEN }, () => {
  const dir = project({ 'lib/demo/rules.ak': RULES, 'lib/demo/rules.test.ak': RULES_TESTS });
  const result = run(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(statusOf(result.stdout, 'needs-a'), 'killed');
  assert.equal(statusOf(result.stdout, 'ignored-b'), 'survived');
  assert.match(result.stdout, /^needs-a\s+\| lib\/demo\/rules\.ak:4\s+\| killed$/m);
  assert.match(result.stdout, /^ignored-b\s+\| lib\/demo\/rules\.ak:6\s+\| survived$/m);
  assert.equal(readFileSync(join(dir, 'lib/demo/rules.ak'), 'utf8'), RULES, 'the source is put back');
});

const GATE = `pub fn gate(x: Option<Bool>) -> Bool {
  when x is {
    None -> True
    // mutant:some-arm
    Some(v) -> v
  }
}
`;

const GATE_TESTS = `use demo/gate

test some_false_is_false() {
  !gate.gate(Some(False))
}

test none_is_true() {
  gate.gate(None)
}
`;

test('exits 0 when every mutant is killed, including a clause behind a Pattern ->', { skip: NEEDS_AIKEN }, () => {
  const dir = project({
    'lib/demo/gate.ak': GATE,
    'lib/demo/gate.test.ak': GATE_TESTS,
    'lib/demo/rules.ak': RULES.replace('    // mutant:ignored-b\n    b,\n', '    b,\n'),
    'lib/demo/rules.test.ak': RULES_TESTS,
  });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(statusOf(result.stdout, 'needs-a'), 'killed');
  assert.equal(statusOf(result.stdout, 'some-arm'), 'killed');
  assert.match(result.stdout, /2 mutants: 2 killed, 0 survived, 0 compile-error/);
});

test('a mutant that does not compile is reported as compile-error and fails the run', { skip: NEEDS_AIKEN }, () => {
  const source = `pub fn bump(x: Int) -> Int {
  // mutant:not-a-bool
  x + 1
}
`;
  const dir = project({
    'lib/demo/bump.ak': source,
    'lib/demo/bump.test.ak': 'use demo/bump\n\ntest adds_one() {\n  bump.bump(1) == 2\n}\n',
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.equal(statusOf(result.stdout, 'not-a-bool'), 'compile-error');
  assert.equal(readFileSync(join(dir, 'lib/demo/bump.ak'), 'utf8'), source);
});

test('stops before judging anything when the untouched project already fails', () => {
  const dir = folder({ 'lib/demo/rules.ak': RULES });
  const failing = join(dir, 'failing-aiken.sh');
  writeFileSync(failing, '#!/bin/sh\necho broken >&2\nexit 1\n');
  chmodSync(failing, 0o755);
  const result = run(dir, { AIKEN: failing });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /before any change/);
  assert.equal(result.stdout, '');
});

test('exits 2 when aiken cannot be started', () => {
  const dir = folder({ 'lib/demo/rules.ak': RULES });
  const result = run(dir, { AIKEN: join(dir, 'no-such-aiken') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot run/);
});

test('a duplicate id is an error, even across files', () => {
  const dir = folder({
    'lib/a.ak': 'pub fn a(x: Bool) -> Bool {\n  // mutant:same\n  x\n}\n',
    'validators/b.ak': 'pub fn b(x: Bool) -> Bool {\n  // mutant:same\n  x\n}\n',
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /validators\/b\.ak:3: duplicate marker same \(first at lib\/a\.ak:3\)/);
});

test('a marker that is not above a single-line clause is an error', () => {
  const cases = {
    'a marker above the closing brace': '  // mutant:x\n',
    'a marker above a binding': '  // mutant:x\n  let y = 1\n',
    'a marker above the opening of a block': '  // mutant:x\n  and {\n    a,\n  }\n',
    'a marker above a closing brace': '  // mutant:x\n  }\n',
    'a marker above an arm with no expression': '  // mutant:x\n  Cancel ->\n    a\n',
    'a marker above a clause that continues': '  // mutant:x\n  a ==\n    b\n',
    'a marker above another marker': '  // mutant:x\n  // mutant:y\n  a\n',
    'a marker with an upper case id': '  // mutant:X\n  a\n',
    'a marker written after a clause': '  a, // mutant:x\n',
    'a marker above a clause that is already True': '  // mutant:x\n  True\n',
  };
  for (const [name, body] of Object.entries(cases)) {
    const dir = folder({ 'lib/m.ak': `pub fn m(a: Bool, b: Bool) -> Bool {\n${body}}\n` });
    const result = run(dir);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /lib\/m\.ak:\d+:/, name);
    assert.equal(result.stdout, '', name);
  }
  const atEnd = run(folder({ 'lib/m.ak': 'pub fn m(a: Bool) -> Bool {\n  a\n}\n// mutant:x\n' }));
  assert.equal(atEnd.status, 1, 'a marker at the end of the file');
  assert.match(atEnd.stderr, /lib\/m\.ak:4: marker x is not followed by a clause/);
});

test('a project with no marker, or only markers in test files, fails', () => {
  const empty = folder({ 'lib/m.ak': 'pub fn m(a: Bool) -> Bool {\n  a\n}\n' });
  assert.equal(run(empty).status, 1);
  const testOnly = folder({
    'lib/m.ak': 'pub fn m(a: Bool) -> Bool {\n  a\n}\n',
    'lib/m.test.ak': 'test t() {\n  // mutant:in-a-test\n  True\n}\n',
  });
  const result = run(testOnly);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no "\/\/ mutant:<id>" markers/);
});

test('exits 2 for an unknown option or a root that is not a folder', () => {
  const unknown = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage/);
  const missing = run(join(tmpdir(), 'mutation-check-does-not-exist'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read/);
});

test('puts the source back when interrupted while a mutant is being judged', async () => {
  const dir = folder({ 'lib/demo/rules.ak': RULES });
  const stub = fakeAiken(dir, 1); // the baseline run is quick, the first mutant hangs
  const file = join(dir, 'lib/demo/rules.ak');
  const proc = spawn(process.execPath, [SCRIPT, '--root', dir], {
    env: { ...process.env, AIKEN: stub },
    stdio: 'ignore',
  });
  const closed = new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 15000;
  while (!(existsSync(join(dir, 'count')) && readFileSync(join(dir, 'count'), 'utf8').trim() === '2')) {
    assert.ok(Date.now() < deadline, 'the script never reached the first mutant');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.notEqual(readFileSync(file, 'utf8'), RULES, 'the clause is replaced while the mutant runs');
  proc.kill('SIGINT');
  const { code } = await closed;
  assert.equal(code, 130);
  assert.equal(readFileSync(file, 'utf8'), RULES, 'the source is put back');
});

// ## A tool failure is not a verdict (Ruling R15)

const ONE_CLAUSE = 'pub fn m(a: Bool) -> Bool {\n  // mutant:only\n  a\n}\n';

function judged(steps) {
  const dir = folder({ 'lib/m.ak': ONE_CLAUSE });
  const result = run(dir, { AIKEN: scriptedAiken(dir, steps) });
  assert.equal(readFileSync(join(dir, 'lib/m.ak'), 'utf8'), ONE_CLAUSE, 'the source is put back');
  return { ...result, status_of: statusOf(result.stdout, 'only') };
}

test('only exit status 1 from the tests run is a kill; 0 is a survivor', () => {
  const killed = judged([0, 0, 1]);
  assert.equal(killed.status, 0);
  assert.equal(killed.status_of, 'killed');
  const survived = judged([0, 0, 0]);
  assert.equal(survived.status, 1);
  assert.equal(survived.status_of, 'survived');
});

test('a tests run that panics (status 101) or is killed by a signal is error, not killed', () => {
  for (const step of [101, 2, 137, 'kill']) {
    const result = judged([0, 0, step]);
    assert.equal(result.status, 1, String(step));
    assert.equal(result.status_of, 'error', String(step));
    assert.match(result.stdout, /1 mutants: 0 killed, 0 survived, 0 compile-error, 1 error/, String(step));
    assert.match(result.stderr, /which says nothing about the tests/, String(step));
  }
});

test('a compile run that exits 1 is compile-error; any other failure of it is error', () => {
  assert.equal(judged([0, 1]).status_of, 'compile-error');
  for (const step of [101, 2, 'kill']) {
    const result = judged([0, step]);
    assert.equal(result.status, 1, String(step));
    assert.equal(result.status_of, 'error', String(step));
  }
});

test('judge gives a verdict only for exit status 0 or 1 without a signal', () => {
  assert.equal(judge('compile', { status: 0, signal: null }), 'ok');
  assert.equal(judge('compile', { status: 1, signal: null }), 'compile-error');
  assert.equal(judge('tests', { status: 0, signal: null }), 'survived');
  assert.equal(judge('tests', { status: 1, signal: null }), 'killed');
  for (const stage of ['compile', 'tests']) {
    assert.equal(judge(stage, { status: 101, signal: null }), 'error');
    assert.equal(judge(stage, { status: 2, signal: null }), 'error');
    assert.equal(judge(stage, { status: null, signal: 'SIGKILL' }), 'error');
    assert.equal(judge(stage, { status: 1, signal: 'SIGTERM' }), 'error');
  }
});

// ## parseClause

test('parseClause replaces only the expression and keeps indentation, arm prefix and comma', () => {
  assert.deepEqual(parseClause('        share > 0,'), { mutated: '        True,' });
  assert.deepEqual(parseClause('    Cancel -> list.has(self.extra_signatories, l.owner)'), {
    mutated: '    Cancel -> True',
  });
  assert.deepEqual(parseClause('        Some(key) -> list.has(signers, key),'), {
    mutated: '        Some(key) -> True,',
  });
  assert.deepEqual(parseClause('  pays(out, a, b, c)   ,   '), { mutated: '  True   ,   ' });
  assert.deepEqual(parseClause('  x == y // why\r'), { mutated: '  True // why\r' });
  assert.deepEqual(parseClause('  out.datum == InlineDatum("a // b"),'), { mutated: '  True,' });
  assert.deepEqual(parseClause('  !list.is_empty(xs)'), { mutated: '  True' });
});

test('parseClause refuses a line that is not a boolean expression on one line', () => {
  for (const line of [
    '',
    '  and {',
    '  }',
    '  let x = 1',
    '  expect Some(l) = datum',
    '  Cancel ->',
    '  a &&',
    '  || b',
    '  foo(a,',
    '  True,',
    '  "open',
  ]) {
    assert.ok(parseClause(line).error, `refuses ${JSON.stringify(line)}`);
  }
});

test('findMarkers reports the clause line, skips comments between marker and clause, and mutates only that line', () => {
  const text = '  and {\n    // mutant:one\n    // a note\n\n    a,\n    // mutant:two\n    b,\n  }\n';
  const { markers, errors } = findMarkers(text, 'lib/x.ak');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    markers.map((marker) => [marker.id, marker.line]),
    [
      ['one', 5],
      ['two', 7],
    ],
  );
  assert.equal(markers[0].mutatedText, text.replace('    a,', '    True,'));
  assert.equal(markers[1].mutatedText, text.replace('    b,', '    True,'));
});
