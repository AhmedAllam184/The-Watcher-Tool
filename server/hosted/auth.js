/**
 * Hosted mode: the app runs on a public web host for one operator.
 *
 * On a laptop the server answers only this machine (see SECURITY.md). Hosted,
 * it answers the internet, and every `/api` route spends the operator's keys,
 * so nothing is served — not the page, not a script, not a single API route —
 * until the browser holds a signed session cookie from the login form.
 *
 * Off unless `GEV_HOSTED=1`. When on, it fails closed: a missing username or a
 * short password stops the server from starting rather than running open.
 */

import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { isHostedMode } from './mode.js';

export { isHostedMode };

export const LOGIN_PATH = '/__watcher/login';
export const LOGOUT_PATH = '/__watcher/logout';
export const SESSION_COOKIE = '__Host-watcher_session';
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;
/** Failed logins allowed from all callers together before logins pause. */
export const LOGIN_FAILURE_LIMIT = 20;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FORM_BYTES = 4096;

/**
 * Read and validate the hosted-mode login settings.
 * @param {Record<string, string|undefined>} env
 * @returns {{user: string, password: string}}
 * @throws {Error} When a setting is missing or too weak.
 */
export function readHostedLogin(env = process.env) {
  const user = String(env.GEV_LOGIN_USER ?? '').trim();
  const password = String(env.GEV_LOGIN_PASSWORD ?? '');
  const problems = [];
  if (!user) problems.push('GEV_LOGIN_USER is not set');
  if (password.length < MIN_PASSWORD_LENGTH)
    problems.push(
      `GEV_LOGIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  if (problems.length)
    throw new Error(
      `Hosted mode refuses to start without a login: ${problems.join('; ')}.`,
    );
  return { user, password };
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name && !(name in cookies))
      cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

/**
 * Sign and check session tokens. The key is derived from the login itself,
 * so there is no extra secret to configure and changing the password signs
 * every existing session out.
 */
export function createSessionSigner({ user, password }) {
  const key = scryptSync(
    `${user}\u0000${password}`,
    'the-watcher-hosted-session-v1',
    32,
  );
  const mac = (value) => createHmac('sha256', key).update(value).digest();
  return {
    issue(nowMs) {
      const expires = String(nowMs + SESSION_MAX_AGE_SEC * 1000);
      return `${expires}.${mac(expires).toString('base64url')}`;
    },
    verify(token, nowMs) {
      const [expires, signature, extra] = String(token ?? '').split('.');
      if (extra !== undefined || !/^\d{1,16}$/.test(expires || ''))
        return false;
      if (Number(expires) <= nowMs) return false;
      let given;
      try {
        given = Buffer.from(signature || '', 'base64url');
      } catch {
        return false;
      }
      const expected = mac(expires);
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    },
  };
}

/** Constant-time comparison of two strings of any length. */
function sameSecret(given, expected) {
  const a = createHmac('sha256', 'compare').update(String(given)).digest();
  const b = createHmac('sha256', 'compare').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/**
 * A fixed window of failed logins shared by every caller. Behind a hosting
 * proxy the client address cannot be trusted, so the limit is global: a
 * guesser gets at most LOGIN_FAILURE_LIMIT tries per window, ever, which is
 * hopeless against a 12+ character password.
 */
export function createLoginThrottle({
  limit = LOGIN_FAILURE_LIMIT,
  windowMs = LOGIN_FAILURE_WINDOW_MS,
} = {}) {
  let windowStart = 0;
  let failures = 0;
  const roll = (nowMs) => {
    if (nowMs - windowStart >= windowMs) {
      windowStart = nowMs;
      failures = 0;
    }
  };
  return {
    blocked(nowMs) {
      roll(nowMs);
      return failures >= limit;
    },
    fail(nowMs) {
      roll(nowMs);
      failures += 1;
    },
    retryAfterSec(nowMs) {
      return Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000));
    },
  };
}

/** Only same-site paths may be a post-login destination. */
export function safeNextPath(value) {
  const next = String(value ?? '');
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return '/';
  if (next.startsWith(LOGIN_PATH) || next.startsWith(LOGOUT_PATH)) return '/';
  return next.slice(0, 2048);
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );

/** The login page. No script, so it runs under the app's strict CSP. */
export function renderLoginPage({ next = '/', message = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>The Watcher — sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #05080c; color: #d7e3ee; font: 16px/1.4 system-ui, sans-serif; }
  form { width: min(340px, calc(100vw - 32px)); display: grid; gap: 12px;
    padding: 28px 24px; border: 1px solid #1f3346; border-radius: 10px;
    background: #0b131b; }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: 0.08em; }
  label { display: grid; gap: 4px; font-size: 13px; color: #8fa6ba; }
  input { padding: 10px 12px; border-radius: 6px; border: 1px solid #2b4359;
    background: #05080c; color: inherit; font-size: 16px; }
  button { margin-top: 6px; padding: 11px; border: 0; border-radius: 6px;
    background: #2f7d5b; color: #fff; font-size: 16px; cursor: pointer; }
  .message { margin: 0; color: #ff9b8a; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="${LOGIN_PATH}">
  <h1>THE WATCHER</h1>
  ${message ? `<p class="message" role="alert">${escapeHtml(message)}</p>` : ''}
  <input type="hidden" name="next" value="${escapeHtml(safeNextPath(next))}">
  <label>Username<input name="username" autocomplete="username" required autofocus></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>
</body>
</html>
`;
}

function readForm(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))),
    );
    req.on('error', () => resolve(null));
  });
}

/** Headers every hosted response carries. */
export const HOSTED_HEADERS = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'same-origin',
});

const wantsPage = (req) =>
  req.method === 'GET' &&
  (String(req.headers.accept || '').includes('text/html') ||
    String(req.headers['sec-fetch-mode'] || '') === 'navigate');

/**
 * Connect-style middleware that admits only signed-in requests.
 * @param {object} options
 * @param {{user: string, password: string}} options.login
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.delay] Slows failed logins.
 */
export function createHostedAuthMiddleware({
  login,
  now = () => Date.now(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  throttle = createLoginThrottle(),
}) {
  const signer = createSessionSigner(login);
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      ...HOSTED_HEADERS,
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  };
  const loginPage = (res, status, next, message) =>
    send(res, status, renderLoginPage({ next, message }), {
      'Content-Type': 'text/html; charset=utf-8',
    });

  return async function hostedAuth(req, res, next) {
    for (const [name, value] of Object.entries(HOSTED_HEADERS))
      res.setHeader(name, value);
    const url = new URL(req.url || '/', 'http://hosted.invalid');

    if (url.pathname === LOGIN_PATH) {
      if (req.method === 'GET')
        return loginPage(res, 200, url.searchParams.get('next'));
      if (req.method !== 'POST')
        return send(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
      const form = await readForm(req);
      const target = safeNextPath(form?.get('next'));
      if (throttle.blocked(now()))
        return loginPage(
          res,
          429,
          target,
          'Too many failed sign-ins. Try again in a few minutes.',
        );
      const userOk = sameSecret(form?.get('username') ?? '', login.user);
      const passwordOk = sameSecret(
        form?.get('password') ?? '',
        login.password,
      );
      if (!form || !userOk || !passwordOk) {
        throttle.fail(now());
        await delay(750);
        return loginPage(res, 401, target, 'Wrong username or password.');
      }
      return send(res, 303, '', {
        Location: target,
        'Set-Cookie': `${SESSION_COOKIE}=${signer.issue(now())}; Max-Age=${SESSION_MAX_AGE_SEC}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      });
    }

    if (url.pathname === LOGOUT_PATH) {
      return send(res, 303, '', {
        Location: LOGIN_PATH,
        'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
      });
    }

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (signer.verify(token, now())) return next();

    if (wantsPage(req)) {
      const back = safeNextPath(`${url.pathname}${url.search}`);
      return send(res, 303, '', {
        Location: `${LOGIN_PATH}?next=${encodeURIComponent(back)}`,
      });
    }
    return send(res, 401, JSON.stringify({ error: 'Sign in required' }), {
      'Content-Type': 'application/json',
    });
  };
}

/**
 * Vite plugin for hosted mode. It runs right after the Host check and ahead
 * of every provider route and static file, on the preview and dev servers.
 * Outside hosted mode it does nothing.
 */
export function hostedAuthPlugin({ env = process.env } = {}) {
  const enabled = isHostedMode(env);
  // Validate at config time so a bad login stops the server before it listens.
  const login = enabled ? readHostedLogin(env) : null;
  const install = (server) => {
    if (!enabled) return;
    server.middlewares.use(createHostedAuthMiddleware({ login }));
  };
  return {
    name: 'hosted-auth',
    enforce: 'pre',
    configureServer: install,
    configurePreviewServer: install,
  };
}
