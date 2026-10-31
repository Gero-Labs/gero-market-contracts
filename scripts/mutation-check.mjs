// Mutation check: proves that every marked clause of the contract is covered by a test.
//
// Usage: node scripts/mutation-check.mjs [--root <dir>]
//
// The contract marks each clause that a test must protect with a comment on its own line,
// directly above the clause:
//
//     // mutant:fee-covered
//     fee_paid >= fee_due,
//
// For every marker in a non-test `.ak` file under `lib/` and `validators/` of the root (default:
// the repository root) this script
//   1. replaces the expression of the clause, the next line that is not a comment, with `True`
//      (the indentation, an optional `Pattern -> ` arm prefix and an optional trailing comma stay);
//   2. runs `aiken check --skip-tests`. If that exits 1, the mutant did not compile: status
//      `compile-error` (a typo must never look like a mutant a test killed);
//   3. runs `aiken check`. If that exits 1, a test noticed the change: status `killed`. If it
//      exits 0, no test depends on the clause: status `survived`;
//   4. puts the file back (also when interrupted by SIGINT, SIGTERM or SIGHUP).
// Before the first mutant it runs `aiken check` on the untouched project: if that already fails,
// every mutant would look killed, so the script stops.
//
// Any other way for either run to end (an exit status other than 0 or 1, such as a panic or an
// out-of-memory kill, or death by a signal) is a tool failure, not a verdict: status `error`.
// Only an exit status of exactly 1 with no signal counts as a failing test or a compile error.
//
// Prints a table `id | file:line | status` on stdout (`file:line` is the mutated clause) and
// a summary line. Exit 0 only if there is at least one marker and every mutant is `killed`.
// Exit 1 for a survivor, a `compile-error`, an `error`, a failing baseline, a duplicate id, a
// marker that is not followed by a single-line clause or a project without markers. A bad option,
// a missing root or an `aiken` that cannot be started exits 2.
//
// Only exit codes of `aiken` are used, never its output: a mutant leaves variables unused and
// so always produces warnings. Property tests run with a fixed seed so that a run is reproducible.
//
// `aiken` comes from PATH, or from the AIKEN environment variable. The script edits the sources
// in place for the length of a run, so do not run it while something else uses the working tree
// (a hard kill, such as SIGKILL, would leave a mutant behind: `git diff` shows it).

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['lib', 'validators'];
const SEED = '1';
const TAIL_BYTES = 4000;

const MARKER_LINE = /^\s*\/\/\s*mutant:([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/;
const MARKER_WORD = /\/\/\s*mutant:/;
const COMMENT_LINE = /^\s*\/\//;
const BLANK_LINE = /^\s*$/;
const NOT_A_CLAUSE_START = /^(?:let|expect|use|pub|const|type|test|validator|else)\b/;
const OPERATOR_START = /^(?:&&|\|\||\|>|[=<>*/%])/;
const OPERATOR_END = /(?:&&|\|\||\|>|\.\.|[=<>+\-*/%|])$/;

/**
 * Splits a clause line into the part to replace and the rest, and returns the line with the
 * expression replaced by `True`: `{ mutated }`. Anything that is not a boolean expression
 * on one line gives `{ error }`.
 *
 * The line is `<indent><optional "Pattern -> "><expression><optional ,><optional // comment>`.
 */
export function parseClause(line) {
  let depth = 0;
  let lowest = 0;
  let arrow = -1;
  let comment = -1;
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '/' && line[i + 1] === '/') {
      comment = i;
      break;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      lowest = Math.min(lowest, depth);
    } else if (c === '-' && line[i + 1] === '>' && depth === 0 && arrow === -1) {
      arrow = i;
    }
  }
  if (inString) return { error: 'a string is not closed on the clause line' };

  let end = comment === -1 ? line.length : comment;
  while (end > 0 && /\s/.test(line[end - 1])) end -= 1;
  if (end > 0 && line[end - 1] === ',') {
    end -= 1;
    while (end > 0 && /\s/.test(line[end - 1])) end -= 1;
  }

  let start = line.length - line.trimStart().length;
  if (arrow !== -1 && arrow < end && !/^fn\b/.test(line.slice(start))) {
    start = arrow + 2;
    while (start < end && /\s/.test(line[start])) start += 1;
  }

  const expression = line.slice(start, Math.max(start, end));
  if (expression === '') return { error: 'there is no expression on the clause line' };
  if (depth !== 0 || lowest < 0) {
    return { error: 'the clause does not close its brackets on the same line' };
  }
  if (NOT_A_CLAUSE_START.test(expression)) {
    return { error: `the line starts a declaration or a binding, not a clause: ${expression}` };
  }
  if (OPERATOR_START.test(expression) || OPERATOR_END.test(expression)) {
    return { error: 'the clause continues on another line' };
  }
  if (expression === 'True') return { error: 'the clause is already True' };
  return { mutated: `${line.slice(0, start)}True${line.slice(end)}` };
}

/**
 * Finds the markers of one file. Returns `{ markers, errors }`: each marker has its id, its
 * 1-based clause line, and the file text with that clause replaced by `True`.
 */
export function findMarkers(text, file) {
  const lines = text.split('\n');
  const markers = [];
  const errors = [];
  for (let i = 0; i < lines.length; i += 1) {
    const found = MARKER_LINE.exec(lines[i]);
    if (!found) {
      if (MARKER_WORD.test(lines[i])) {
        errors.push(`${file}:${i + 1}: malformed marker, expected a line "// mutant:<id>" with a lowercase id`);
      }
      continue;
    }
    const id = found[1];
    let j = i + 1;
    while (j < lines.length && (BLANK_LINE.test(lines[j]) || (COMMENT_LINE.test(lines[j]) && !MARKER_LINE.test(lines[j])))) {
      j += 1;
    }
    if (j >= lines.length || MARKER_LINE.test(lines[j])) {
      errors.push(`${file}:${i + 1}: marker ${id} is not followed by a clause`);
      continue;
    }
    const clause = parseClause(lines[j]);
    if (clause.error) {
      errors.push(`${file}:${j + 1}: marker ${id} is not above a mutable clause: ${clause.error}`);
      continue;
    }
    const mutated = lines.slice();
    mutated[j] = clause.mutated;
    markers.push({ id, file, line: j + 1, mutatedText: mutated.join('\n') });
  }
  return { markers, errors };
}

function sourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (name.endsWith('.ak') && !name.endsWith('.test.ak')) files.push(path);
    }
  };
  for (const dir of SOURCE_DIRS) visit(join(root, dir));
  return files;
}

function discover(root) {
  if (!statSync(root).isDirectory()) throw new Error('not a folder');
  const markers = [];
  const errors = [];
  const originals = new Map();
  for (const path of sourceFiles(root)) {
    const buffer = readFileSync(path);
    const file = relative(root, path).split('\\').join('/');
    const found = findMarkers(buffer.toString('utf8'), file);
    originals.set(file, { path, buffer });
    markers.push(...found.markers);
    errors.push(...found.errors);
  }
  const seen = new Map();
  for (const marker of markers) {
    if (seen.has(marker.id)) {
      errors.push(`${marker.file}:${marker.line}: duplicate marker ${marker.id} (first at ${seen.get(marker.id)})`);
    } else {
      seen.set(marker.id, `${marker.file}:${marker.line}`);
    }
  }
  return { markers, errors, originals };
}

// The file that is mutated right now, and the aiken process running on it.
let active = null;
let child = null;

function restoreActive() {
  if (active) {
    const { path, buffer } = active;
    active = null;
    writeFileSync(path, buffer);
  }
}

/**
 * Runs `aiken <args>` in `cwd`. Resolves `{ status, signal, tail }` (`status` is null when a
 * signal ended the process), or `{ launchError }` if it cannot start.
 */
function runAiken(aiken, args, cwd) {
  return new Promise((resolvePromise) => {
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
    };
    const proc = spawn(aiken, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.on('error', (error) => {
      child = null;
      resolvePromise({ launchError: error });
    });
    proc.on('close', (status, signal) => {
      child = null;
      resolvePromise({ status, signal, tail });
    });
  });
}

/**
 * The status of one mutant from the runs of aiken. `stage` is `compile` for
 * `aiken check --skip-tests` and `tests` for `aiken check`. Only exit status 0 and exactly 1,
 * with no signal, are verdicts: anything else is a tool failure and gives `error`.
 * Returns `ok` when the compile stage passes, so the caller goes on to the tests.
 */
export function judge(stage, { status, signal }) {
  const exited = signal === null || signal === undefined;
  if (exited && status === 0) return stage === 'compile' ? 'ok' : 'survived';
  if (exited && status === 1) return stage === 'compile' ? 'compile-error' : 'killed';
  return 'error';
}

/** The stderr text for a mutant whose aiken run was a tool failure. */
function failure(marker, run, result) {
  const how = result.signal ? `was ended by ${result.signal}` : `exited with status ${result.status}`;
  return `\n${marker.id} (${marker.file}:${marker.line}): ${run} ${how}, which says nothing about the tests:\n${result.tail}\n`;
}

function table(rows) {
  const header = ['id', 'file:line', 'status'];
  const body = rows.map((row) => [row.id, `${row.file}:${row.line}`, row.status]);
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((row) => row[column].length)));
  const format = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ').trimEnd();
  return [format(header), widths.map((width) => '-'.repeat(width)).join('-+-'), ...body.map(format)].join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs({ args: argv, options: { root: { type: 'string' } }, allowPositionals: false }).values;
  } catch (error) {
    console.error(`mutation-check: ${error.message}`);
    console.error('usage: node scripts/mutation-check.mjs [--root <dir>]');
    return 2;
  }
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const aiken = process.env.AIKEN || 'aiken';

  let found;
  try {
    found = discover(root);
  } catch (error) {
    console.error(`mutation-check: cannot read ${root}: ${error.message}`);
    return 2;
  }
  if (found.errors.length > 0) {
    for (const message of found.errors) console.error(message);
    return 1;
  }
  if (found.markers.length === 0) {
    console.error(`mutation-check: no "// mutant:<id>" markers found under ${SOURCE_DIRS.join(' or ')} in ${root}`);
    return 1;
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      child?.kill('SIGTERM');
      restoreActive();
      process.exit(128 + osConstants.signals[signal]);
    });
  }
  process.on('exit', restoreActive);

  const started = Date.now();
  const check = ['check', '-S', '--seed', SEED];
  const baseline = await runAiken(aiken, check, root);
  if (baseline.launchError) {
    console.error(`mutation-check: cannot run ${aiken}: ${baseline.launchError.message} (put aiken on PATH or set AIKEN)`);
    return 2;
  }
  if (baseline.status !== 0) {
    console.error('mutation-check: the project does not pass `aiken check` before any change, so no mutant could be judged:');
    console.error(baseline.tail);
    return 1;
  }

  const rows = [];
  let diagnostics = '';
  for (const marker of found.markers) {
    const { path, buffer } = found.originals.get(marker.file);
    let status;
    try {
      active = { path, buffer };
      writeFileSync(path, marker.mutatedText);
      const compiled = await runAiken(aiken, ['check', '-S', '--skip-tests'], root);
      if (compiled.launchError) throw compiled.launchError;
      status = judge('compile', compiled);
      if (status === 'ok') {
        const tested = await runAiken(aiken, check, root);
        if (tested.launchError) throw tested.launchError;
        status = judge('tests', tested);
        if (status === 'error') diagnostics += failure(marker, 'the tests run', tested);
      } else if (status === 'compile-error') {
        diagnostics += `\n${marker.id} (${marker.file}:${marker.line}) does not compile when replaced by True:\n${compiled.tail}\n`;
      } else {
        diagnostics += failure(marker, 'the compile run', compiled);
      }
    } finally {
      restoreActive();
    }
    console.error(`mutant ${marker.id}: ${status}`);
    rows.push({ id: marker.id, file: marker.file, line: marker.line, status });
  }

  console.log(table(rows));
  const count = (status) => rows.filter((row) => row.status === status).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${rows.length} mutants: ${count('killed')} killed, ${count('survived')} survived, ` +
      `${count('compile-error')} compile-error, ${count('error')} error (${seconds}s)`,
  );
  if (diagnostics) console.error(diagnostics);
  return rows.every((row) => row.status === 'killed') ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`mutation-check: ${error.stack ?? error}`);
      process.exitCode = 2;
    },
  );
}
