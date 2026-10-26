/**
 * @module squawkAlerts
 * @description Announces emergency transponder squawks reported by the flight
 * layers. Listens for `watcher:squawk-emergency`, shows at most one toast per
 * interval (coalescing the rest into "+N more") and keeps the last alerts in
 * memory. Detection belongs to the layers, not to this listener.
 */
import { SQUAWK_EMERGENCY_EVENT } from '../data/squawk.js';

const TOAST_INTERVAL_MS = 10000;
const RECENT_LIMIT = 20;

/** Toast text for one alert, e.g. "⚠ UAL123 squawking 7700 — General emergency". */
function alertMessage(alert) {
  const label = alert.callsign || alert.icao24 || 'Aircraft';
  return `⚠ ${label} squawking ${alert.code} — ${alert.meaning}`;
}

/**
 * Create the squawk alert listener.
 * @param {object} options
 * @param {(message: string) => void} options.showToast Shell toast presenter.
 * @param {EventTarget} [options.target=window] Where the layer events are dispatched.
 * @param {() => number} [options.now] Clock in epoch milliseconds.
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 * @returns {{recent: () => object[], destroy: () => void}}
 */
export function createSquawkAlerts({
  showToast,
  target = globalThis.window ?? null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  let queued = [];
  let timer = null;
  let lastShownAt = null;
  let destroyed = false;
  const recent = [];

  function flush() {
    timer = null;
    if (destroyed || queued.length === 0) return;
    const [first, ...others] = queued;
    queued = [];
    lastShownAt = now();
    showToast(
      others.length
        ? `${alertMessage(first)} (+${others.length} more)`
        : alertMessage(first),
    );
  }

  function onAlert(event) {
    const detail = event?.detail;
    if (destroyed || !detail?.code) return;
    recent.push(detail);
    if (recent.length > RECENT_LIMIT) recent.shift();
    queued.push(detail);
    if (timer !== null) return;
    const wait =
      lastShownAt === null
        ? 0
        : Math.max(0, lastShownAt + TOAST_INTERVAL_MS - now());
    timer = setTimer(flush, wait);
  }

  target?.addEventListener(SQUAWK_EMERGENCY_EVENT, onAlert);

  return {
    /** Most recent alerts, oldest first (at most 20). */
    recent: () => recent.slice(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      target?.removeEventListener(SQUAWK_EMERGENCY_EVENT, onAlert);
      if (timer !== null) clearTimer(timer);
      timer = null;
      queued = [];
    },
  };
}
