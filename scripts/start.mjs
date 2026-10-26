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
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const host = process.env.HOST || '127.0.0.1';
const port = String(process.env.PORT || '4173');
const url = `http://127.0.0.1:${port}`;
const forceRebuild = process.argv.slice(2).includes('--rebuild');

/** Inputs whose change means the existing dist/ no longer matches the code. */
const INPUT_DIRECTORIES = ['src', 'server', 'build', 'public'];
const INPUT_FILES = [
  'index.html',
  'style.css',
  'package.json',
  'package-lock.json',
  'vite.config.js',
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

/** Whether dist/ is missing or older than the newest build input. */
export function buildIsStale(projectRoot = root, { rebuild = false } = {}) {
  if (rebuild) return true;
  const marker = path.join(projectRoot, 'dist', 'index.html');
  if (!existsSync(marker)) return true;
  return newestInputMtime(projectRoot) > statSync(marker).mtimeMs;
}

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

async function waitUntilServing(child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const response = await fetch(url, {
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
