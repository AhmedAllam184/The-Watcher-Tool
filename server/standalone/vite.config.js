import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { hostedAuthPlugin, isHostedMode } from '../hosted/auth.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  // Hosted mode answers its host's public name (Hugging Face sets SPACE_HOST).
  const hostedNames = isHostedMode()
    ? [process.env.SPACE_HOST, process.env.GEV_PUBLIC_HOST]
    : [];
  return createBrowserViteConfig({
    plugins: [
      // Sign-in first: no route or file is served to a stranger when hosted.
      hostedAuthPlugin(),
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(
      [process.env.GEV_ALLOWED_HOSTS, ...hostedNames].filter(Boolean).join(','),
    ),
    command,
  });
});
