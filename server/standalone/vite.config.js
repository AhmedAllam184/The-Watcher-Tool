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
  // Render supplies the service's public hostname at runtime.
  const hostedNames = isHostedMode()
    ? [process.env.RENDER_EXTERNAL_HOSTNAME, process.env.GEV_PUBLIC_HOST]
    : [];
  return createBrowserViteConfig({
    plugins: [
      // Sign-in first: no route or file is served to a stranger when hosted.
      hostedAuthPlugin(),
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: isHostedMode() ? '' : process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: isHostedMode() ? '' : process.env.CESIUM_ION_TOKEN,
    mapillaryToken: isHostedMode() ? '' : process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(
      [process.env.GEV_ALLOWED_HOSTS, ...hostedNames].filter(Boolean).join(','),
    ),
    command,
  });
});
