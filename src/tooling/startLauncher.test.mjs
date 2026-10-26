import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BUILD_ENV_KEYS,
  buildIsStale,
  parseDotenv,
  serveUrl,
  waitUntilServing,
  writeBuildStamp,
} from '../../scripts/start.mjs';

const SECOND = 1000;
const BASE = Date.UTC(2026, 9, 26, 12, 0, 0) / SECOND;
/** The launcher reads the real process environment unless a test says otherwise. */
const NO_ENV = { env: {} };

function project(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['src', 'server', 'dist'])
    mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

function touch(file, seconds) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  utimesSync(file, seconds, seconds);
}

/** A dist/ build that is newer than every input, stamped with `env`. */
function builtProject(t, env = {}) {
  const dir = project(t);
  touch(path.join(dir, 'src', 'app.js'), BASE + 50);
  touch(path.join(dir, 'dist', 'index.html'), BASE + 100);
  writeBuildStamp(dir, env);
  return dir;
}

test('the fast start rebuilds when dist/ is missing, older than a source, or forced', (t) => {
  const dir = project(t);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'no dist yet');

  const marker = path.join(dir, 'dist', 'index.html');
  touch(marker, BASE + 100);
  touch(path.join(dir, 'src', 'app.js'), BASE + 50);
  writeBuildStamp(dir, {});
  assert.equal(
    buildIsStale(dir, NO_ENV),
    false,
    'build newer than every input',
  );

  touch(path.join(dir, 'server', 'api.js'), BASE + 200);
  assert.equal(
    buildIsStale(dir, NO_ENV),
    true,
    'a server file changed after the build',
  );

  touch(marker, BASE + 300);
  assert.equal(buildIsStale(dir, NO_ENV), false);
  assert.equal(
    buildIsStale(dir, { ...NO_ENV, rebuild: true }),
    true,
    '--rebuild always rebuilds',
  );
});

test('changes outside the build inputs do not force a rebuild', (t) => {
  const dir = builtProject(t);
  touch(path.join(dir, 'docs-note.md'), BASE + 500);
  assert.equal(buildIsStale(dir, NO_ENV), false);
});

test('a build without a stamp is stale, so a build from before this check rebuilds once', (t) => {
  const dir = project(t);
  touch(path.join(dir, 'dist', 'index.html'), BASE + 100);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'no stamp');
  writeFileSync(path.join(dir, 'dist', '.watcher-build.json'), '{not json');
  assert.equal(buildIsStale(dir, NO_ENV), true, 'unreadable stamp');
});

test('a changed GOOGLE_MAPS_API_KEY in .env rebuilds, though no source changed', (t) => {
  const dir = builtProject(t);
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, 'GOOGLE_MAPS_API_KEY=maps-key-one\n');
  utimesSync(envFile, BASE + 10, BASE + 10);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'a key the build did not have');

  writeBuildStamp(dir, {});
  assert.equal(buildIsStale(dir, NO_ENV), false, 'the stamp matches .env');

  writeFileSync(envFile, 'GOOGLE_MAPS_API_KEY=maps-key-two\n');
  utimesSync(envFile, BASE + 10, BASE + 10);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'the bundled key changed');
});

test('a changed value in the process environment rebuilds, an unrelated variable does not', (t) => {
  const dir = builtProject(t, { CESIUM_ION_TOKEN: 'ion-token-a' });
  assert.equal(
    buildIsStale(dir, { env: { CESIUM_ION_TOKEN: 'ion-token-a', HOME: '/x' } }),
    false,
    'same token, unrelated variable',
  );
  assert.equal(
    buildIsStale(dir, { env: { CESIUM_ION_TOKEN: 'ion-token-b' } }),
    true,
    'a different token',
  );
  assert.equal(
    buildIsStale(dir, { env: {} }),
    true,
    'a token removed since the build',
  );
});

test('a VITE_ variable counts as a build input', (t) => {
  const dir = builtProject(t, { VITE_FEATURE_FLAG: 'on' });
  assert.equal(buildIsStale(dir, { env: { VITE_FEATURE_FLAG: 'off' } }), true);
  assert.equal(buildIsStale(dir, { env: { VITE_FEATURE_FLAG: 'on' } }), false);
});

test('.env is a build input by modification time as well as by value', (t) => {
  const dir = builtProject(t);
  touch(path.join(dir, '.env'), BASE + 200);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'an edited .env');
});

test('pinokio/ENVIRONMENT values and its modification time are build inputs', (t) => {
  const dir = builtProject(t);
  const environment = path.join(dir, 'pinokio', 'ENVIRONMENT');
  touch(environment, BASE + 10);
  writeFileSync(environment, 'MAPILLARY_CLIENT_TOKEN=mapillary-one\n');
  utimesSync(environment, BASE + 10, BASE + 10);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'a key the build did not have');

  writeBuildStamp(dir, {});
  assert.equal(buildIsStale(dir, NO_ENV), false, 'the stamp matches');

  writeFileSync(environment, 'MAPILLARY_CLIENT_TOKEN=mapillary-two\n');
  utimesSync(environment, BASE + 10, BASE + 10);
  assert.equal(buildIsStale(dir, NO_ENV), true, 'the value changed');
});

test('the stamp keeps a digest, never the key value', (t) => {
  const SECRET = 'sk-live-SECRET-value-123';
  const dir = project(t);
  writeFileSync(path.join(dir, '.env'), `GOOGLE_MAPS_API_KEY=${SECRET}\n`);
  writeBuildStamp(dir, {});
  const stamp = readFileSync(
    path.join(dir, 'dist', '.watcher-build.json'),
    'utf8',
  );
  assert.doesNotMatch(stamp, /SECRET|sk-live/);
  assert.match(JSON.parse(stamp).envSha256, /^[0-9a-f]{64}$/);
});

test('parseDotenv reads KEY=VALUE lines with export, quotes and comments', () => {
  assert.deepEqual(
    parseDotenv(
      [
        '# a comment',
        '',
        'GOOGLE_MAPS_API_KEY=plain',
        'export CESIUM_ION_TOKEN="quoted value"',
        "MAPILLARY_CLIENT_TOKEN='single'",
        'VITE_NAME=value # trailing comment',
        'not a pair',
        'EMPTY=',
      ].join('\r\n'),
    ),
    {
      GOOGLE_MAPS_API_KEY: 'plain',
      CESIUM_ION_TOKEN: 'quoted value',
      MAPILLARY_CLIENT_TOKEN: 'single',
      VITE_NAME: 'value',
      EMPTY: '',
    },
  );
});

test('BUILD_ENV_KEYS covers every key that build/vite.js defines for the bundle', () => {
  const source = readFileSync(
    new URL('../../build/vite.js', import.meta.url),
    'utf8',
  );
  const defined = [...source.matchAll(/'import\.meta\.env\.([A-Z_]+)'/g)].map(
    (match) => match[1],
  );
  assert.ok(defined.length >= 3);
  for (const key of defined) {
    assert.ok(BUILD_ENV_KEYS.includes(key), `${key} must be a build input`);
  }
});

test('the probe and the browser URL use loopback for a wildcard bind', () => {
  assert.equal(serveUrl('127.0.0.1', '4173'), 'http://127.0.0.1:4173');
  assert.equal(serveUrl('0.0.0.0', '4173'), 'http://127.0.0.1:4173');
  assert.equal(serveUrl('::', '4173'), 'http://127.0.0.1:4173');
  assert.equal(serveUrl('localhost', 4173), 'http://localhost:4173');
  assert.equal(serveUrl('192.168.1.20', 4173), 'http://192.168.1.20:4173');
});

test('an IPv6 host is wrapped in brackets, and an already bracketed one is not doubled', () => {
  assert.equal(serveUrl('::1', 4173), 'http://[::1]:4173');
  assert.equal(serveUrl('fe80::1', 4173), 'http://[fe80::1]:4173');
  assert.equal(serveUrl('[::1]', 4173), 'http://[::1]:4173');
});

test('waitUntilServing finds a server bound to a wildcard host through loopback', async () => {
  const server = createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const child = { exitCode: null, signalCode: null };
    assert.equal(
      await waitUntilServing(child, serveUrl('0.0.0.0', port), 5_000),
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('waitUntilServing gives up when nothing answers at the probed address', async () => {
  const child = { exitCode: null, signalCode: null };
  assert.equal(
    await waitUntilServing(child, serveUrl('0.0.0.0', 1), 1_000),
    false,
  );
});
