/** Hosted HTML supplies browser-only keys after the sign-in gate. */
export const runtimeBrowserKeys = JSON.parse(
  globalThis.document?.getElementById?.('watcher-runtime')?.textContent || '{}',
);
