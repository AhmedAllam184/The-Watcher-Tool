/**
 * @module squawk
 * @description Pure transponder squawk policy: emergency code meanings and the
 * once-per-contact transition that decides when an emergency is announced.
 * No DOM, no Cesium, no network access.
 */

/** Transponder codes that signal an emergency, with their plain meanings. */
export const EMERGENCY_SQUAWKS = Object.freeze({
  7500: 'Hijack / unlawful interference',
  7600: 'Radio failure',
  7700: 'General emergency',
});

/** Window event dispatched once per contact and code when it starts squawking an emergency. */
export const SQUAWK_EMERGENCY_EVENT = 'watcher:squawk-emergency';

/** Upper bound on remembered emergency contacts; oldest untouched entries drop first. */
const MAX_TRACKED_CONTACTS = 500;

/**
 * Normalize a transponder code to four decimal digits.
 * @param {unknown} value Raw squawk from a source row.
 * @returns {string|null} The four-digit code, or null when it is absent or malformed.
 */
export function normalizeSquawk(value) {
  const text = String(value ?? '').trim();
  // Transponder codes are four octal digits (0-7).
  return /^[0-7]{4}$/.test(text) ? text : null;
}

/**
 * Describe a transponder code.
 * @param {unknown} code Raw or normalized squawk.
 * @returns {{code: string, meaning: string|null, emergency: boolean}|null}
 *   Null when the code is absent or malformed.
 */
export function describeSquawk(code) {
  const normalized = normalizeSquawk(code);
  if (!normalized) return null;
  const meaning = Object.hasOwn(EMERGENCY_SQUAWKS, normalized)
    ? EMERGENCY_SQUAWKS[normalized]
    : null;
  return { code: normalized, meaning, emergency: meaning !== null };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Find contacts that have newly started squawking an emergency code.
 *
 * A contact alerts when its emergency code differs from the one remembered for
 * it, so repeated polls with the same code stay silent. A contact that keeps its
 * code through a short absence from the snapshot stays remembered and does not
 * re-alert when it reappears. Clearing the code forgets the contact.
 *
 * @param {Map<string, string>|null} previousMap Contact id to the emergency code last announced.
 * @param {Iterable<{id: string, callsign?: string|null, squawk?: unknown, latitude?: number|null, longitude?: number|null}>} records
 *   Normalized aircraft observations from the latest accepted snapshot.
 * @returns {{alerts: Array<{icao24: string, callsign: string|null, code: string, meaning: string, latitude: number|null, longitude: number|null}>, next: Map<string, string>}}
 *   Newly-emergency contacts, and the map to pass as `previousMap` next time.
 */
export function diffEmergencies(previousMap, records) {
  const next = new Map(previousMap instanceof Map ? previousMap : []);
  const alerts = [];
  for (const record of records ?? []) {
    const icao24 = String(record?.id ?? '').trim();
    if (!icao24) continue;
    const before = next.get(icao24);
    next.delete(icao24);
    const squawk = describeSquawk(record.squawk);
    if (!squawk?.emergency) continue;
    next.set(icao24, squawk.code);
    if (before === squawk.code) continue;
    alerts.push({
      icao24,
      callsign: String(record.callsign ?? '').trim() || null,
      code: squawk.code,
      meaning: squawk.meaning,
      latitude: finiteOrNull(record.latitude),
      longitude: finiteOrNull(record.longitude),
    });
  }
  while (next.size > MAX_TRACKED_CONTACTS) {
    next.delete(next.keys().next().value);
  }
  return { alerts, next };
}

/**
 * Dispatch one `watcher:squawk-emergency` event per alert on `target`.
 * @param {EventTarget & {CustomEvent?: Function}|null} target Usually `window`; null is a no-op.
 * @param {string} layerId Layer that observed the squawk, e.g. `flights`.
 * @param {Array<object>} alerts Alerts from {@link diffEmergencies}.
 * @returns {number} Number of events dispatched.
 */
export function emitSquawkEmergencies(target, layerId, alerts) {
  if (
    !target ||
    typeof target.dispatchEvent !== 'function' ||
    typeof target.CustomEvent !== 'function'
  )
    return 0;
  let count = 0;
  for (const alert of alerts ?? []) {
    target.dispatchEvent(
      new target.CustomEvent(SQUAWK_EMERGENCY_EVENT, {
        detail: { layerId, ...alert },
      }),
    );
    count += 1;
  }
  return count;
}
