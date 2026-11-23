import { createStandaloneApplication } from './standalone/application.js';
import { runtimeBrowserKeys } from './standalone/runtimeKeys.js';
import { describeError } from './standalone/errors.js';

const application = createStandaloneApplication({
  googleApiKey:
    runtimeBrowserKeys.GOOGLE_MAPS_API_KEY ??
    import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken:
    runtimeBrowserKeys.CESIUM_ION_TOKEN ?? import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error('The Watcher initialization failed:', error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
