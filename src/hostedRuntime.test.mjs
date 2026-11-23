import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  hostedAuthPlugin,
  injectHostedRuntime,
  SESSION_COOKIE,
  createSessionSigner,
} from '../server/hosted/auth.js';

const env = {
  GEV_HOSTED: '1',
  GEV_LOGIN_USER: 'fixture',
  GEV_LOGIN_PASSWORD: 'fixture-password-long',
  GOOGLE_MAPS_API_KEY: 'fake-google-hosted',
  CESIUM_ION_TOKEN: 'fake-cesium-hosted',
  MAPILLARY_CLIENT_TOKEN: 'fake-mapillary-hosted',
  OPENAI_API_KEY: 'fake-server-secret',
};

test('hosted preview inserts only browser keys after authentication and never caches them', async (t) => {
  const root = mkdtempSync(resolve('.hosted-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'dist'));
  writeFileSync(
    resolve(root, 'dist/index.html'),
    '<html><head></head><body>app</body></html>',
  );
  const stack = [];
  hostedAuthPlugin({ env }).configurePreviewServer({
    config: {
      root,
      build: { outDir: 'dist' },
      preview: { headers: { 'X-Test': 'preserved' } },
    },
    middlewares: {
      use(fn) {
        stack.push(fn);
      },
    },
  });
  async function request(url, cookie = '', accept = 'text/html') {
    const req = new EventEmitter();
    Object.assign(req, {
      url,
      method: 'GET',
      headers: { accept, cookie },
    });
    const result = { headers: {}, body: '' };
    const res = {
      setHeader(name, value) {
        result.headers[name] = value;
      },
      writeHead(status, headers) {
        result.status = status;
        Object.assign(result.headers, headers);
      },
      end(body = '') {
        result.body = body;
      },
    };
    let index = 0;
    const next = () => stack[index++]?.(req, res, next);
    await next();
    return result;
  }
  for (const path of [
    '/',
    '/index.html',
    '/__watcher/login',
    '/assets/app.js',
  ]) {
    const response = await request(path);
    for (const key of [
      'GOOGLE_MAPS_API_KEY',
      'CESIUM_ION_TOKEN',
      'MAPILLARY_CLIENT_TOKEN',
    ]) {
      assert.ok(!response.body.includes(env[key]), path);
    }
    assert.notEqual(
      response.body,
      '<html><head></head><body>app</body></html>',
    );
  }
  const api = await request('/api/flights', '', 'application/json');
  assert.equal(api.status, 401);
  for (const value of Object.values(env)) assert.ok(!api.body.includes(value));
  const token = createSessionSigner({
    user: env.GEV_LOGIN_USER,
    password: env.GEV_LOGIN_PASSWORD,
  }).issue(Date.now());
  const response = await request('/', `${SESSION_COOKIE}=${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Test'], 'preserved');
  for (const key of [
    'GOOGLE_MAPS_API_KEY',
    'CESIUM_ION_TOKEN',
    'MAPILLARY_CLIENT_TOKEN',
  ]) {
    assert.ok(response.body.includes(env[key]));
  }
  assert.ok(!response.body.includes(env.OPENAI_API_KEY));
});

test('runtime JSON cannot break out of the inert script element', () => {
  const dangerous = '</script><script>alert(1)</script>&\u2028\u2029';
  const html = injectHostedRuntime('<head></head>', {
    GOOGLE_MAPS_API_KEY: dangerous,
  });
  const json = html.match(/type="application\/json">(.*?)<\/script>/s)[1];
  assert.ok(!json.includes('<'));
  assert.ok(!json.includes('&'));
  assert.equal(JSON.parse(json).GOOGLE_MAPS_API_KEY, dangerous);
});

test('build HTML never receives runtime values and local mode adds no middleware', () => {
  const html = '<head></head>';
  assert.equal(hostedAuthPlugin({ env }).transformIndexHtml(html, {}), html);
  const plugin = hostedAuthPlugin({ env: {} });
  plugin.configureServer({
    middlewares: {
      use() {
        assert.fail('local middleware');
      },
    },
  });
  plugin.configurePreviewServer({});
  assert.equal(plugin.transformIndexHtml(html, { server: {} }), html);
  const weak = hostedAuthPlugin({
    env: { ...env, GEV_LOGIN_PASSWORD: 'short' },
  });
  assert.throws(() => weak.configurePreviewServer({}), /at least 12/);
});

test('hosted config omits browser defines without login; local config keeps existing inputs', async () => {
  const { default: configFactory } =
    await import('../server/standalone/vite.config.js');
  const names = [...Object.keys(env), 'RENDER_EXTERNAL_HOSTNAME'];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, env, {
      RENDER_EXTERNAL_HOSTNAME: 'fixture.onrender.com',
    });
    delete process.env.GEV_LOGIN_USER;
    delete process.env.GEV_LOGIN_PASSWORD;
    const hosted = configFactory({ command: 'build', mode: 'test' });
    for (const key of [
      'GOOGLE_MAPS_API_KEY',
      'CESIUM_ION_TOKEN',
      'MAPILLARY_CLIENT_TOKEN',
    ]) {
      assert.equal(hosted.define[`import.meta.env.${key}`], '""');
    }
    assert.ok(hosted.server.allowedHosts.includes('fixture.onrender.com'));
    delete process.env.GEV_HOSTED;
    const local = configFactory({ command: 'build', mode: 'test' });
    for (const key of [
      'GOOGLE_MAPS_API_KEY',
      'CESIUM_ION_TOKEN',
      'MAPILLARY_CLIENT_TOKEN',
    ]) {
      assert.equal(
        local.define[`import.meta.env.${key}`],
        JSON.stringify(env[key]),
      );
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('browser runtime reads inert JSON and leaves local builds without overrides', async () => {
  const saved = globalThis.document;
  try {
    delete globalThis.document;
    const local = await import('./standalone/runtimeKeys.js?local-fixture');
    assert.deepEqual(local.runtimeBrowserKeys, {});
    globalThis.document = {
      getElementById: () => ({
        textContent: JSON.stringify({
          GOOGLE_MAPS_API_KEY: env.GOOGLE_MAPS_API_KEY,
        }),
      }),
    };
    const hosted = await import('./standalone/runtimeKeys.js?hosted-fixture');
    assert.equal(
      hosted.runtimeBrowserKeys.GOOGLE_MAPS_API_KEY,
      env.GOOGLE_MAPS_API_KEY,
    );
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
});
