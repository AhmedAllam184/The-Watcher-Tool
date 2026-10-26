import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildIsStale } from '../../scripts/start.mjs';

const SECOND = 1000;
const BASE = Date.UTC(2026, 9, 26, 12, 0, 0) / SECOND;

function project(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['src', 'server', 'dist'])
    mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function touch(file, seconds) {
  writeFileSync(file, 'x');
  utimesSync(file, seconds, seconds);
}

test('the fast start rebuilds when dist/ is missing, older than a source, or forced', (t) => {
  const dir = project(t);
  assert.equal(buildIsStale(dir), true, 'no dist yet');

  const marker = path.join(dir, 'dist', 'index.html');
  touch(marker, BASE + 100);
  touch(path.join(dir, 'src', 'app.js'), BASE + 50);
  assert.equal(buildIsStale(dir), false, 'build newer than every input');

  touch(path.join(dir, 'server', 'api.js'), BASE + 200);
  assert.equal(
    buildIsStale(dir),
    true,
    'a server file changed after the build',
  );

  touch(marker, BASE + 300);
  assert.equal(buildIsStale(dir), false);
  assert.equal(
    buildIsStale(dir, { rebuild: true }),
    true,
    '--rebuild always rebuilds',
  );
});

test('changes outside the build inputs do not force a rebuild', (t) => {
  const dir = project(t);
  touch(path.join(dir, 'dist', 'index.html'), BASE + 100);
  touch(path.join(dir, 'docs-note.md'), BASE + 500);
  assert.equal(buildIsStale(dir), false);
});
