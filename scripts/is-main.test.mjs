import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { isMain } from './lib/is-main.mjs';
import { tempDirs } from './test-helpers.mjs';

const dirs = tempDirs();
after(() => dirs.cleanup());

/** A folder with a real module file, a symlink to the folder and a symlink to the file. */
function layout() {
  const base = dirs.make('is-main-');
  const real = join(base, 'real');
  mkdirSync(real);
  const module = join(real, 'tool.mjs');
  writeFileSync(module, '');
  const dirLink = join(base, 'dir-link');
  symlinkSync(real, dirLink, 'dir');
  const fileLink = join(base, 'file-link.mjs');
  symlinkSync(module, fileLink);
  return { base, module, url: pathToFileURL(module).href, dirLink, fileLink };
}

test('the module is main when started through its real path', () => {
  const { module, url } = layout();
  assert.equal(isMain(url, module), true);
});

test('the module is main when started through a symlinked folder or a symlinked file', () => {
  const { url, dirLink, fileLink } = layout();
  assert.equal(isMain(url, join(dirLink, 'tool.mjs')), true);
  assert.equal(isMain(url, fileLink), true);
});

test('the module is not main when another file is the entry point', () => {
  const { base, url } = layout();
  const other = join(base, 'other.mjs');
  writeFileSync(other, '');
  assert.equal(isMain(url, other), false);
});

test('a missing or unknown entry point is not main and does not throw', () => {
  const { base, url } = layout();
  assert.equal(isMain(url, undefined), false);
  assert.equal(isMain(url, join(base, 'does-not-exist.mjs')), false);
});
