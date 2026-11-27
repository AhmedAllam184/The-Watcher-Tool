// Hermetic visual acceptance: no environment files, provider middleware or
// dependency-junction writes. Uses the application's normal HTML/Cesium build.
import { createBrowserViteConfig } from '../build/vite.js';

export default {
  ...createBrowserViteConfig({ command: 'build', port: 4175 }),
  envDir: false,
  cacheDir: '.mobile-cache',
};
