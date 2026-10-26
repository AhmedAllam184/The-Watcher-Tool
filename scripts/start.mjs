#!/usr/bin/env node
// Fast local start: serve a production build with `vite preview`.
//
// `npm run dev` (Vite's dev server) compiles hundreds of unbundled modules on
// every load and is much slower to open. This script builds into dist/ only
// when the build is missing or older than the sources, then serves it. The
// POWER UP key panel and its POST route are dev-only, so for those use
// `npm run dev` (see "Setup Keys (dev mode).cmd").
//
// Usage: npm start [-- --rebuild]
// Environment: HOST (default 127.0.0.1), PORT (default 4173).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const host = process.env.HOST || '127.0.0.1';
const port = String(process.env.PORT || '4173');
const forceRebuild = process.argv.slice(2).includes('--rebuild');

/**
 * Dotenv files that Vite's loadEnv reads for a production build, lowest
 * precedence first, then Pinokio's environment file.
 */
const BUILD_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
];
const PINOKIO_ENV_FILE = 'pinokio/ENVIRONMENT';
/**
 * Keys compiled into the bundle: the `define` block in build/vite.js and
 * anything under VITE_. Changing one of them means dist/ must be rebuilt.
 */
export const BUILD_ENV_KEYS = Object.freeze([
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  'MAPILLARY_CLIENT_TOKEN',
]);
const BUILD_STAMP = '.watcher-build.json';

/** Inputs whose change means the existing dist/ no longer matches the code. */
const INPUT_DIRECTORIES = ['src', 'server', 'build', 'public'];
const INPUT_FILES = [
  'index.html',
  'style.css',
  'package.json',
  'package-lock.json',
  'vite.config.js',
  ...BUILD_ENV_FILES,
  PINOKIO_ENV_FILE,
];

/** Newest mtime (ms) among the build inputs, or 0 when none exist. */
export function newestInputMtime(projectRoot = root) {
  let newest = 0;
  const visit = (entry) => {
    let info;
    try {
      info = statSync(entry);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const child of readdirSync(entry)) visit(path.join(entry, child));
    } else {
      newest = Math.max(newest, info.mtimeMs);
    }
  };
  for (const directory of INPUT_DIRECTORIES) {
    const absolute = path.join(projectRoot, directory);
    if (existsSync(absolute)) visit(absolute);
  }
  for (const file of INPUT_FILES) {
    const absolute = path.join(projectRoot, file);
    if (existsSync(absolute)) visit(absolute);
  }
  return newest;
}

/** Parse dotenv text: KEY=VALUE lines, optional `export`, quotes and comments. */
export function parseDotenv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'" || quote === '`') &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[match[1]] = value;
  }
  return values;
}

function readEnvFile(file) {
  try {
    return parseDotenv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const isBuildEnvKey = (key) =>
  BUILD_ENV_KEYS.includes(key) || key.startsWith('VITE_');

/**
 * SHA-256 over the build-relevant env values, as the build will see them: the
 * process environment wins over the dotenv files, as in server/standalone's
 * vite config. Only the digest leaves this function, never a value.
 */
export function buildEnvDigest(projectRoot = root, env = process.env) {
  const fromFiles = {};
  for (const file of [...BUILD_ENV_FILES, PINOKIO_ENV_FILE]) {
    Object.assign(fromFiles, readEnvFile(path.join(projectRoot, file)));
  }
  const resolved = {};
  for (const [key, value] of Object.entries(fromFiles)) {
    if (isBuildEnvKey(key)) resolved[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (isBuildEnvKey(key) && value !== undefined) resolved[key] = value;
  }
  const entries = Object.keys(resolved)
    .sort()
    .map((key) => [key, resolved[key]]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

const stampPath = (projectRoot) => path.join(projectRoot, 'dist', BUILD_STAMP);

/** Record which build-relevant env the current dist/ was built with. */
export function writeBuildStamp(projectRoot = root, env = process.env) {
  writeFileSync(
    stampPath(projectRoot),
    `${JSON.stringify({ envSha256: buildEnvDigest(projectRoot, env) })}\n`,
    'utf8',
  );
}

/** The env digest recorded by the last build, or null when there is no stamp. */
function readBuildStamp(projectRoot) {
  try {
    const stamp = JSON.parse(readFileSync(stampPath(projectRoot), 'utf8'));
    return typeof stamp?.envSha256 === 'string' ? stamp.envSha256 : null;
  } catch {
    return null;
  }
}

/**
 * Whether dist/ is missing, older than the newest build input, or was built
 * with different build-relevant env values (or before the stamp existed).
 */
export function buildIsStale(
  projectRoot = root,
  { rebuild = false, env = process.env } = {},
) {
  if (rebuild) return true;
  const marker = path.join(projectRoot, 'dist', 'index.html');
  if (!existsSync(marker)) return true;
  if (readBuildStamp(projectRoot) !== buildEnvDigest(projectRoot, env))
    return true;
  return newestInputMtime(projectRoot) > statSync(marker).mtimeMs;
}

/**
 * The URL to probe and open for a server bound to `bindHost`. A wildcard bind
 * is reached through loopback; an IPv6 literal is wrapped in brackets.
 */
export function serveUrl(bindHost, servePort) {
  const bare = String(bindHost)
    .trim()
    .replace(/^\[(.*)\]$/, '$1');
  const reachable =
    bare === '' || bare === '0.0.0.0' || bare === '::' ? '127.0.0.1' : bare;
  const shown = reachable.includes(':') ? `[${reachable}]` : reachable;
  return `http://${shown}:${servePort}`;
}

const url = serveUrl(host, port);

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [viteBin, ...args], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on('error', () => resolve(1));
  });
}

export async function waitUntilServing(
  child,
  target = url,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const response = await fetch(target, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Open the browser with the platform's launcher; failure is not fatal. */
function openBrowser(target) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${target}"`];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  try {
    const opener = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    opener.on('error', () => {});
    opener.unref();
  } catch {
    console.log(`Open ${target} in your browser.`);
  }
}

async function main() {
  if (!existsSync(viteBin)) {
    console.error('Dependencies are missing. Run "npm ci" first.');
    return 1;
  }
  if (buildIsStale(root, { rebuild: forceRebuild })) {
    console.log(
      'Building The Watcher (first start or code changed)... about 20 seconds.',
    );
    const code = await run(['build']);
    if (code !== 0) {
      console.error('The build failed. Fix the error above and start again.');
      return code;
    }
    writeBuildStamp(root);
  } else {
    console.log('Production build is up to date; starting the server.');
  }

  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', host, '--port', port, '--strictPort'],
    { cwd: root, stdio: 'inherit' },
  );
  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  // Attach the exit listener before anything can await, so a server that dies
  // during startup still ends this script instead of leaving it waiting.
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      // A Ctrl+C stop is a normal exit, not a failure.
      resolve(signal ? 0 : (code ?? 0));
    });
  });

  if (await waitUntilServing(child)) {
    console.log(`Ready: ${url}`);
    openBrowser(url);
  } else if (child.exitCode === null && child.signalCode === null) {
    console.error(`The server did not answer at ${url} within two minutes.`);
  }
  return exited;
}

// Run only when executed directly, so the staleness helpers stay importable.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
