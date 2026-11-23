import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Offline hosted acceptance gate. Run after a hosted build with these fixtures.
const keys = {
  GOOGLE_MAPS_API_KEY: 'fake-google-hosted',
  CESIUM_ION_TOKEN: 'fake-cesium-hosted',
  MAPILLARY_CLIENT_TOKEN: 'fake-mapillary-hosted',
};
const vite = resolve('node_modules/vite/bin/vite.js');
const baseEnv = {
  ...process.env,
  GEV_HOSTED: '1',
  NODE_OPTIONS: '--max-old-space-size=384',
  ...keys,
};
delete baseEnv.GEV_LOGIN_USER;
delete baseEnv.GEV_LOGIN_PASSWORD;
const previewArgs = [
  vite,
  'preview',
  '--configLoader',
  'runner',
  '--host',
  '127.0.0.1',
  '--port',
  '4189',
  '--strictPort',
];
let hits = 0;
let files = 0;
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else {
      files++;
      const bytes = readFileSync(path);
      for (const value of Object.values(keys))
        if (bytes.includes(Buffer.from(value))) hits++;
    }
  }
}
scan('dist');
assert.equal(hits, 0, 'fake browser keys must never enter built files');
console.log(JSON.stringify({ distFiles: files, fakeKeyHits: hits }));
for (const login of [
  {},
  { GEV_LOGIN_USER: 'fixture', GEV_LOGIN_PASSWORD: 'short' },
]) {
  const result = spawnSync(process.execPath, previewArgs, {
    env: { ...baseEnv, ...login },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hosted mode refuses to start without a login/);
}
console.log('Missing and weak login both refused at actual preview startup.');
const login = {
  GEV_LOGIN_USER: 'fixture',
  GEV_LOGIN_PASSWORD: 'fixture-password-long',
};
const child = spawn(process.execPath, previewArgs, {
  env: { ...baseEnv, ...login },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => {
  output += data;
});
child.stderr.on('data', (data) => {
  output += data;
});
function rss() {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`],
      { encoding: 'utf8' },
    );
    return Math.round((Number(result.stdout.trim()) / 1024 / 1024) * 100) / 100;
  }
  return (
    Math.round(
      (Number(
        readFileSync(`/proc/${child.pid}/status`, 'utf8').match(
          /^VmRSS:\s+(\d+)/m,
        )[1],
      ) /
        1024) *
        100,
    ) / 100
  );
}
try {
  for (
    let i = 0;
    i < 100 && !output.includes('Local:') && child.exitCode === null;
    i++
  )
    await delay(100);
  assert.equal(child.exitCode, null, output.slice(-500));
  assert.ok(output.includes('Local:'), 'preview ready');
  await delay(1500);
  console.log(JSON.stringify({ pid: child.pid, idleRssMiB: rss() }));
  const base = 'http://127.0.0.1:4189';
  const anonymous = await fetch(`${base}/`, {
    headers: { Accept: 'text/html' },
  });
  const anonymousHtml = await anonymous.text();
  assert.match(anonymousHtml, /Sign in/);
  for (const value of Object.values(keys))
    assert.ok(!anonymousHtml.includes(value));
  const signed = await fetch(`${base}/__watcher/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: login.GEV_LOGIN_USER,
      password: login.GEV_LOGIN_PASSWORD,
    }),
  });
  assert.equal(signed.status, 303);
  const cookie = signed.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  const html = await response.text();
  for (const value of Object.values(keys)) assert.ok(html.includes(value));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await delay(500);
  console.log(
    JSON.stringify({
      afterPageRssMiB: rss(),
      authenticatedHtml: 'pass',
      anonymousHtml: 'pass',
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      smokeFailure: error.message,
      cause: error.cause?.code,
      afterPageRssMiB: 'unavailable if request was blocked',
    }),
  );
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((done) => child.once('exit', done));
}
