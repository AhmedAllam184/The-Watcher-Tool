import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_COOKIE,
  createHostedAuthMiddleware,
  createLoginThrottle,
  createSessionSigner,
  hostedAuthPlugin,
  isHostedMode,
  parseCookies,
  readHostedLogin,
  renderLoginPage,
  safeNextPath,
} from '../server/hosted/auth.js';
import { admitSameSite } from '../server/providers/common/same-site.js';

const LOGIN = Object.freeze({
  user: 'ahmed',
  password: 'correct horse battery',
});

async function serve(t, options = {}) {
  const clock = { now: 1_000_000 };
  const middleware = createHostedAuthMiddleware({
    login: LOGIN,
    now: () => clock.now,
    delay: async () => {},
    ...options,
  });
  const server = createServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`app:${req.url}`);
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) =>
    fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const signIn = (fields) =>
    request(LOGIN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  return { clock, request, signIn };
}

const cookieFrom = (response) =>
  String(response.headers.get('set-cookie') || '').split(';')[0];

test('hosted mode is opt-in and refuses to start without a strong login', () => {
  assert.equal(isHostedMode({}), false);
  assert.equal(isHostedMode({ GEV_HOSTED: '1' }), true);
  assert.throws(() => readHostedLogin({}), /GEV_LOGIN_USER is not set/);
  assert.throws(
    () =>
      readHostedLogin({ GEV_LOGIN_USER: 'me', GEV_LOGIN_PASSWORD: 'short' }),
    /at least 12 characters/,
  );
  assert.deepEqual(
    readHostedLogin({
      GEV_LOGIN_USER: ' me ',
      GEV_LOGIN_PASSWORD: 'long enough pw',
    }),
    { user: 'me', password: 'long enough pw' },
  );
  // Builds need no credentials; only starting a server validates the login.
  const plugin = hostedAuthPlugin({ env: { GEV_HOSTED: '1' } });
  assert.throws(() => plugin.configureServer({}), /GEV_LOGIN_USER/);
  assert.throws(() => plugin.configurePreviewServer({}), /GEV_LOGIN_USER/);
  assert.doesNotThrow(() => hostedAuthPlugin({ env: {} }));
});

test('nothing is served before sign-in: pages redirect, everything else is 401', async (t) => {
  const { request } = await serve(t);
  const page = await request('/?share=1', { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 303);
  assert.equal(
    page.headers.get('location'),
    `${LOGIN_PATH}?next=${encodeURIComponent('/?share=1')}`,
  );
  for (const path of ['/api/flights', '/assets/index.js', '/mcp']) {
    const response = await request(path);
    assert.equal(response.status, 401, path);
    assert.doesNotMatch(await response.text(), /app:/);
  }
  const form = await request(LOGIN_PATH);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /<form method="post"/);
  assert.equal(form.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(form.headers.get('strict-transport-security'), /max-age=/);
});

test('the right login sets a secure session cookie that opens the app', async (t) => {
  const { request, signIn } = await serve(t);
  const response = await signIn({
    username: 'ahmed',
    password: LOGIN.password,
    next: '/?layers=flights',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?layers=flights');
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])
    assert.match(setCookie, new RegExp(flag));
  const app = await request('/api/flights', {
    headers: { Cookie: cookieFrom(response) },
  });
  assert.equal(app.status, 200);
  assert.equal(await app.text(), 'app:/api/flights');
});

test('a wrong username or password is refused and changes nothing', async (t) => {
  const { signIn } = await serve(t);
  for (const fields of [
    { username: 'ahmed', password: 'wrong password!!' },
    { username: 'someone', password: LOGIN.password },
    { username: '', password: '' },
  ]) {
    const response = await signIn(fields);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(await response.text(), /Wrong username or password/);
  }
});

test('failed sign-ins pause logins for everyone once the limit is reached', async (t) => {
  const { signIn, clock } = await serve(t, {
    throttle: createLoginThrottle({ limit: 3, windowMs: 60_000 }),
  });
  for (let i = 0; i < 3; i += 1)
    assert.equal((await signIn({ username: 'x', password: 'y' })).status, 401);
  // Even the right password waits out the window.
  const paused = await signIn({ username: 'ahmed', password: LOGIN.password });
  assert.equal(paused.status, 429);
  assert.equal(paused.headers.get('set-cookie'), null);
  clock.now += 60_000;
  const later = await signIn({ username: 'ahmed', password: LOGIN.password });
  assert.equal(later.status, 303);
});

test('forged, tampered and expired sessions are refused; sign-out clears the cookie', async (t) => {
  const { request, signIn, clock } = await serve(t);
  const cookie = cookieFrom(
    await signIn({ username: 'ahmed', password: LOGIN.password }),
  );
  const [name, token] = cookie.split('=');
  const [expires, signature] = token.split('.');
  const other = createSessionSigner({
    user: 'ahmed',
    password: 'another password',
  });
  for (const forged of [
    `${name}=${Number(expires) + 1}.${signature}`,
    `${name}=${other.issue(clock.now)}`,
    `${name}=${expires}`,
    `${name}=garbage`,
  ]) {
    assert.equal(
      (await request('/api/flights', { headers: { Cookie: forged } })).status,
      401,
      forged,
    );
  }
  clock.now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(
    (await request('/api/flights', { headers: { Cookie: cookie } })).status,
    401,
  );
  const out = await request(LOGOUT_PATH);
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('the post-login destination never leaves the site', () => {
  assert.equal(safeNextPath('/?a=1'), '/?a=1');
  for (const bad of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    `${LOGIN_PATH}?next=/`,
    undefined,
  ])
    assert.equal(safeNextPath(bad), '/', String(bad));
  assert.doesNotMatch(
    renderLoginPage({ next: '/"><script>', message: '<b>x</b>' }),
    /<script>|<b>x/,
  );
  assert.deepEqual(parseCookies('a=1; b = two ;bad; a=3'), {
    a: '1',
    b: 'two',
  });
});

test('the cross-site gate trusts the host proxy only in hosted mode', (t) => {
  const prior = process.env.GEV_HOSTED;
  t.after(() => {
    if (prior === undefined) delete process.env.GEV_HOSTED;
    else process.env.GEV_HOSTED = prior;
  });
  const proxied = (origin) => {
    const sent = {};
    const res = {
      setHeader() {},
      end(body) {
        sent.body = body;
      },
    };
    const refused = admitSameSite(
      {
        headers: {
          host: 'me-the-watcher.hf.space',
          origin,
          'x-forwarded-for': '203.0.113.9',
          'x-forwarded-proto': 'https',
        },
        socket: {},
      },
      res,
    );
    return { refused, status: res.statusCode };
  };
  delete process.env.GEV_HOSTED;
  assert.equal(proxied('https://me-the-watcher.hf.space').refused, true);
  process.env.GEV_HOSTED = '1';
  assert.equal(proxied('https://me-the-watcher.hf.space').refused, false);
  // A foreign page still cannot spend the keys.
  assert.equal(proxied('https://evil.example').refused, true);
});
