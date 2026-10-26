import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isDegraded } from '../../../src/data/gpsJam.js';
import { detectHolding } from '../../../src/data/holdingDetection.js';
import { greatCircleKm } from '../../../src/data/routePlausible.js';
import { parseGeojsonLines } from '../../../src/sources/infrastructureData.js';
import { WATCHER_USER_AGENT } from '../common/userAgent.js';

/**
 * Airport disruption inference, served at GET /api/airports/status. Each
 * watched airport is sampled with adsb.lol's keyless v2 point API (40 nm
 * radius). Two signals are read from the samples:
 *   - holding: an aircraft whose recent track shows a circling episode near the
 *     airport (src/data/holdingDetection.js), below 20,000 ft;
 *   - degraded GPS: airborne aircraft broadcasting NIC < 7 or NACp < 8
 *     (src/data/gpsJam.js isDegraded).
 * Both are INFERENCES from live positions, not official airport status, and
 * every response says so.
 *
 * Sampling: a tick every 10 s polls ONE airport, and only while the endpoint is
 * active. Active means a /api/airports/status request arrived within the last
 * 10 min; the timer starts on the first request and stops on the first tick
 * after the window lapses. Nothing polls at import time. A request may name up
 * to 8 ICAO codes (?codes=) that become temporary airports for 15 min, at most
 * 16 at once, oldest evicted first.
 *
 * Tiers (see priorityTier): the priority tier is up to 4 airports: up to 2
 * watchlist airports rated disrupted (then watch), then viewed airports (most
 * recent request first) to fill the rest. Each priority airport is polled about
 * every 60 s. The base rotation is the watchlist plus any viewed airport outside
 * the tier, polled at least every 30 s, so every viewed airport is sampled too.
 * The base cycle is about 32 airports at about 2 polls per minute, roughly 16 min
 * each, which is enough for the GPS share but not for holding. Holding is
 * reported only for an airport whose last three polls were at most 3 min apart
 * (holdingReliable). A viewed airport outside the priority tier is never
 * assessed for holding; every other airport is marked not assessed until then.
 *
 * A failing airport backs off for 5 min and its failure is logged at most once
 * per 10 min. Track history (40 min) and the last successful sample of each
 * watched airport are persisted to cachePath at most every 60 s, written
 * temp-then-rename, and reloaded on first start.
 *
 * Routes:
 *   GET /api/airports/status[?codes=OERK,OEJN] → {generatedAt, airports,
 *     method, note, source}
 *
 * @returns {import('vite').Plugin}
 */

export const AIRPORT_WATCH_SOURCE = 'adsb.lol (ODbL)';
export const AIRPORT_WATCH_NOTE =
  'Inferred from live aircraft positions (adsb.lol). Holding = repeated circling near the airport; degraded GPS may indicate interference. Not official airport status.';
export const AIRPORT_WATCH_METHOD =
  'Holding: an aircraft circling (at least 330° of net turn within 25 min) within 40 km of the airport, below 20,000 ft, with the circling ending in the last 20 min. Degraded GPS: share of airborne aircraft within 40 nm broadcasting NIC < 7, or NACp < 8 when NIC is absent. Ratings need at least 6 judged aircraft for the GPS share.';

/**
 * Watched airports. ICAO is the key; IATA is the fallback match when the
 * dataset spells the ICAO code differently (Kuwait is OKKK in the bundled
 * dataset). Coordinates come from the bundled airports dataset.
 */
export const AIRPORT_WATCHLIST = Object.freeze([
  { icao: 'OERK', iata: 'RUH' },
  { icao: 'OEJN', iata: 'JED' },
  { icao: 'OEDF', iata: 'DMM' },
  { icao: 'OMDB', iata: 'DXB' },
  { icao: 'OMDW', iata: 'DWC' },
  { icao: 'OMAA', iata: 'AUH' },
  { icao: 'OTHH', iata: 'DOH' },
  { icao: 'OBBI', iata: 'BAH' },
  { icao: 'OKBK', iata: 'KWI' },
  { icao: 'OOMS', iata: 'MCT' },
  { icao: 'LLBG', iata: 'TLV' },
  { icao: 'OJAI', iata: 'AMM' },
  { icao: 'OLBA', iata: 'BEY' },
  { icao: 'HECA', iata: 'CAI' },
  { icao: 'LTFM', iata: 'IST' },
  { icao: 'LTFJ', iata: 'SAW' },
  { icao: 'ORBI', iata: 'BGW' },
  { icao: 'ORER', iata: 'EBL' },
  { icao: 'OIIE', iata: 'IKA' },
  { icao: 'OIII', iata: 'THR' },
  { icao: 'EPWA', iata: 'WAW' },
  { icao: 'EFHK', iata: 'HEL' },
  { icao: 'EVRA', iata: 'RIX' },
  { icao: 'EYVI', iata: 'VNO' },
  { icao: 'EETN', iata: 'TLL' },
  { icao: 'LGAV', iata: 'ATH' },
  { icao: 'LCLK', iata: 'LCA' },
  { icao: 'LCPH', iata: 'PFO' },
  { icao: 'EGLL', iata: 'LHR' },
  { icao: 'LFPG', iata: 'CDG' },
  { icao: 'EDDF', iata: 'FRA' },
  { icao: 'KJFK', iata: 'JFK' },
]);

const DEFAULT_AIRPORTS_PATH = fileURLToPath(
  new URL(
    '../../../src/data/local_data/airports/airports.geojsonl',
    import.meta.url,
  ),
);
const RADIUS_NM = 40;
/** One poll is considered per tick. */
const TICK_MS = 10_000;
/** A priority airport is polled when its last poll is at least this old. */
const PRIORITY_MS = 60_000;
/** The base watchlist is polled at least this often. */
const BASE_FORCE_MS = 30_000;
const PRIORITY_MAX = 4;
/** Of the priority tier, at most this many are watchlist airports rated watch or disrupted. */
const AFFECTED_PRIORITY_MAX = 2;
/** Holding is assessed only after this many polls, each at most RELIABLE_GAP_MS apart. */
const RELIABLE_SAMPLES = 3;
const RELIABLE_GAP_MS = 3 * 60_000;
const UNASSESSED_REASON = 'holding not assessed (sampled every ~16 min)';
const IDLE_MS = 10 * 60_000;
const TEMP_TTL_MS = 15 * 60_000;
const TEMP_MAX = 16;
const CODES_MAX = 8;
const BACKOFF_MS = 5 * 60_000;
const LOG_EVERY_MS = 10 * 60_000;
const SAVE_EVERY_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const TRACK_MS = 40 * 60_000;
/** Positions farther than this from the airport are not tracked (60 nm). */
const TRACK_RANGE_KM = 60 * 1.852;
const HOLD_RECENT_MS = 20 * 60_000;
const HOLD_RANGE_KM = 40;
const HOLD_MAX_ALT_FT = 20_000;
const HOLD_MIN_FIXES = 3;
/** A sample older than this is not used for the GPS share or the rating. */
const SAMPLE_FRESH_MS = 20 * 60_000;
const MAX_POSITION_AGE_S = 60;
const MIN_JUDGED = 6;
const HOLDING_DISRUPTED = 3;
const SHARE_DISRUPTED = 0.25;
const SHARE_WATCH = 0.1;
const CALLSIGNS_MAX = 5;

const ICAO_PATTERN = /^[A-Z0-9]{4}$/;

const round3 = (value) => Math.round(value * 1000) / 1000;
const normalizeHex = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/**
 * Validate the ?codes= value. An absent parameter is an empty list; otherwise
 * a comma-separated list of up to 8 ICAO codes, case-insensitive, de-duplicated.
 * @returns {{codes: string[]}|{error: string}}
 */
export function parseAirportCodes(raw) {
  if (raw === null) return { codes: [] };
  const parts = String(raw)
    .split(',')
    .map((code) => code.trim().toUpperCase());
  if (parts.length > CODES_MAX) return { error: 'too many codes' };
  if (parts.some((code) => !ICAO_PATTERN.test(code)))
    return { error: 'invalid codes' };
  return { codes: [...new Set(parts)] };
}

/** Dataset feature → airport record, or null when it has no ICAO or position. */
function featureToAirport(feature) {
  const props = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [];
  const icao = typeof props.icao === 'string' ? props.icao.trim() : '';
  if (!icao || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    icao,
    iata: typeof props.iata === 'string' ? props.iata.trim() : '',
    name: typeof props.name === 'string' ? props.name.trim() : '',
    city: typeof props.city === 'string' ? props.city.trim() : '',
    lat,
    lon,
  };
}

/**
 * Resolve the watchlist against airport records: ICAO first, then IATA.
 * @returns {{airports: object[], missing: string[]}}
 */
export function resolveWatchlist(airports, entries = AIRPORT_WATCHLIST) {
  const byIcao = new Map();
  const byIata = new Map();
  for (const airport of airports) {
    if (!byIcao.has(airport.icao)) byIcao.set(airport.icao, airport);
    if (airport.iata && !byIata.has(airport.iata))
      byIata.set(airport.iata, airport);
  }
  const found = [];
  const missing = [];
  for (const entry of entries) {
    const airport = byIcao.get(entry.icao) ?? byIata.get(entry.iata);
    if (airport && !found.includes(airport)) found.push(airport);
    else if (!airport) missing.push(entry.icao);
  }
  return { airports: found, missing };
}

/**
 * Holding and GPS-share rating from counts. Pure.
 * @returns {{level: 'normal'|'watch'|'disrupted', reasons: string[]}}
 */
export function rateAirport({ holding, judged, degraded }) {
  const share = judged > 0 ? degraded / judged : null;
  const shareCounts = judged >= MIN_JUDGED && share !== null;
  const reasons = [];
  if (holding >= 1) reasons.push(`${holding} aircraft holding`);
  if (shareCounts && share >= SHARE_WATCH)
    reasons.push(`${Math.round(share * 100)}% report degraded GPS`);
  let level = 'normal';
  if (holding >= HOLDING_DISRUPTED || (shareCounts && share >= SHARE_DISRUPTED))
    level = 'disrupted';
  else if (holding >= 1 || (shareCounts && share >= SHARE_WATCH))
    level = 'watch';
  return { level, reasons };
}

/**
 * Altitude (ft) of the last fix at or before `t`. Null when that fix was on
 * the ground or there is none, so a taxiing aircraft is never a hold.
 */
function altitudeAt(points, t) {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].t <= t) return points[i].altFt;
  }
  return null;
}

/** One episode counts when it ended recently, near the airport, below the ceiling. */
function holdsAt(episode, points, airport, t) {
  if (episode.endT < t - HOLD_RECENT_MS) return false;
  if (
    greatCircleKm(
      episode.centerLat,
      episode.centerLon,
      airport.lat,
      airport.lon,
    ) > HOLD_RANGE_KM
  )
    return false;
  const altFt = altitudeAt(points, episode.endT);
  return altFt !== null && altFt < HOLD_MAX_ALT_FT;
}

/**
 * Hexes whose recent track holds an episode that ended in the last 20 min,
 * centred within 40 km of the airport, below 20,000 ft.
 * @returns {Array<{hex: string, flight: string}>}
 */
function holdingAircraft(airport, t) {
  const found = [];
  for (const [hex, track] of airport.tracks) {
    if (track.points.length < HOLD_MIN_FIXES) continue;
    const holds = detectHolding(track.points).some((episode) =>
      holdsAt(episode, track.points, airport, t),
    );
    if (holds) found.push({ hex, flight: track.flight });
  }
  return found;
}

/** True when the last three polls were at most RELIABLE_GAP_MS apart and the latest is recent. */
function holdingReliable(airport, t) {
  const polls = airport.pollTimes;
  if (polls.length < RELIABLE_SAMPLES) return false;
  if (t - polls[polls.length - 1] > RELIABLE_GAP_MS) return false;
  for (let i = 1; i < polls.length; i++) {
    if (polls[i] - polls[i - 1] > RELIABLE_GAP_MS) return false;
  }
  return true;
}

/**
 * Public shape of one airport at time `t`. `assessable: false` reports holding
 * as not assessed whatever the poll history says.
 */
function airportStatus(airport, t, { assessable = true } = {}) {
  const base = {
    icao: airport.icao,
    iata: airport.iata,
    name: airport.name,
    city: airport.city,
    lat: airport.lat,
    lon: airport.lon,
    lastPolledAt: airport.lastPolledAt,
  };
  const reliable = assessable && holdingReliable(airport, t);
  const unassessed = reliable ? [] : [UNASSESSED_REASON];
  const fresh =
    airport.lastOkAt !== null && t - airport.lastOkAt <= SAMPLE_FRESH_MS;
  if (!fresh) {
    return {
      ...base,
      holdingReliable: reliable,
      aircraftNearby: 0,
      holding: null,
      holdingCallsigns: [],
      degradedGps: 0,
      judged: 0,
      degradedShare: null,
      level: 'unknown',
      reasons: [
        airport.lastOkAt === null
          ? 'no successful poll yet'
          : 'no recent sample',
        ...unassessed,
      ],
    };
  }
  const holds = reliable ? holdingAircraft(airport, t) : [];
  const rating = rateAirport({
    holding: holds.length,
    judged: airport.judged,
    degraded: airport.degraded,
  });
  return {
    ...base,
    holdingReliable: reliable,
    aircraftNearby: airport.aircraftNearby,
    holding: reliable ? holds.length : null,
    holdingCallsigns: holds
      .map(({ hex, flight }) => flight || hex)
      .slice(0, CALLSIGNS_MAX),
    degradedGps: airport.degraded,
    judged: airport.judged,
    degradedShare:
      airport.judged > 0 ? round3(airport.degraded / airport.judged) : null,
    level: rating.level,
    reasons: [...rating.reasons, ...unassessed],
  };
}

function newState(airport, extra = {}) {
  return {
    ...airport,
    lastPolledAt: null,
    /** The last three poll attempts, for holdingReliable. */
    pollTimes: [],
    lastOkAt: null,
    backoffUntil: 0,
    lastLoggedAt: -Infinity,
    aircraftNearby: 0,
    judged: 0,
    degraded: 0,
    /** hex → { flight, points: [{t, lat, lon, altFt}] } */
    tracks: new Map(),
    ...extra,
  };
}

/** Drop fixes older than the track window, then hexes with no fixes left. */
function pruneTracks(airport, t) {
  for (const [hex, track] of airport.tracks) {
    track.points = track.points.filter((point) => point.t > t - TRACK_MS);
    if (track.points.length === 0) airport.tracks.delete(hex);
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.cachePath]
 * @param {() => number} [options.now]
 * @param {string} [options.airportsPath] Bundled airports GeoJSON Lines file.
 * @param {Array<{icao: string, lat: number, lon: number, iata?: string, name?: string, city?: string}>} [options.watchlist]
 *   Replaces the bundled watchlist and dataset (tests).
 * @param {Array<object>} [options.catalogue] Extra airports that ?codes= may
 *   name when `watchlist` replaces the dataset (tests).
 */
export function airportWatchProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'airport-watch.json'),
  now = Date.now,
  airportsPath = DEFAULT_AIRPORTS_PATH,
  watchlist = null,
  catalogue: extraAirports = [],
} = {}) {
  /** ICAO → airport record, for resolving ?codes= */
  let catalogue = new Map();
  /** @type {Array<ReturnType<typeof newState>>} */
  let base = [];
  /** @type {Array<ReturnType<typeof newState>>} */
  let temps = [];
  let cursor = 0;
  let lastBasePollAt = -Infinity;
  let lastRequestAt = -Infinity;
  /** @type {?ReturnType<typeof setInterval>} */
  let timer = null;
  /** @type {?Promise<void>} */
  let loading = null;
  let busy = false;
  let dirty = false;
  let saving = false;
  let lastSaveAt = -Infinity;

  /** Base airports plus live temporary airports, in rotation order. */
  const rotation = () => [...base, ...temps];

  function pruneTemps(t) {
    temps = temps.filter((airport) => airport.expiresAt > t);
  }

  function addTemps(codes, t) {
    pruneTemps(t);
    for (const code of codes) {
      if (base.some((airport) => airport.icao === code)) continue;
      const existing = temps.find((airport) => airport.icao === code);
      if (existing) {
        existing.expiresAt = t + TEMP_TTL_MS;
        existing.requestedAt = t;
        continue;
      }
      const airport = catalogue.get(code);
      if (!airport) continue;
      if (temps.length >= TEMP_MAX) {
        const oldest = temps.reduce((a, b) => (a.addedAt <= b.addedAt ? a : b));
        temps = temps.filter((item) => item !== oldest);
      }
      temps.push(
        newState(airport, {
          addedAt: t,
          requestedAt: t,
          expiresAt: t + TEMP_TTL_MS,
        }),
      );
    }
  }

  /** Restore persisted samples for watched airports; stale ones age out on read. */
  function restore(json, t) {
    if (!Array.isArray(json?.airports)) return;
    for (const saved of json.airports) {
      const airport = base.find((item) => item.icao === saved?.icao);
      if (!airport) continue;
      if (Number.isFinite(saved.lastPolledAt))
        airport.lastPolledAt = saved.lastPolledAt;
      if (Number.isFinite(saved.lastOkAt)) airport.lastOkAt = saved.lastOkAt;
      if (Number.isFinite(saved.aircraftNearby))
        airport.aircraftNearby = saved.aircraftNearby;
      if (Number.isFinite(saved.judged)) airport.judged = saved.judged;
      if (Number.isFinite(saved.degraded)) airport.degraded = saved.degraded;
      if (Array.isArray(saved.tracks)) {
        for (const entry of saved.tracks) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
          const points = Array.isArray(entry[2])
            ? entry[2].filter(
                (p) =>
                  Number.isFinite(p?.t) &&
                  Number.isFinite(p?.lat) &&
                  Number.isFinite(p?.lon),
              )
            : [];
          airport.tracks.set(entry[0], {
            flight: typeof entry[1] === 'string' ? entry[1] : '',
            points,
          });
        }
      }
      pruneTracks(airport, t);
    }
  }

  /** Load the bundled dataset and persisted samples once, before the first poll. */
  function loadOnce() {
    if (!loading) {
      loading = (async () => {
        try {
          if (watchlist) {
            catalogue = new Map(
              [...watchlist, ...extraAirports].map((airport) => [
                airport.icao,
                { ...airport },
              ]),
            );
            base = watchlist.map((airport) => newState({ ...airport }));
          } else {
            const airports = parseGeojsonLines(
              await fsp.readFile(airportsPath, 'utf8'),
            )
              .map(featureToAirport)
              .filter(Boolean);
            catalogue = new Map();
            for (const airport of airports) {
              if (!catalogue.has(airport.icao))
                catalogue.set(airport.icao, airport);
            }
            const { airports: found, missing } = resolveWatchlist(airports);
            if (missing.length)
              console.warn(
                `[airport-watch] not in airports dataset: ${missing.join(', ')}`,
              );
            base = found.map((airport) => newState(airport));
          }
        } catch (err) {
          console.warn(
            '[airport-watch] airports dataset unavailable:',
            err?.message || err,
          );
        }
        try {
          restore(JSON.parse(await fsp.readFile(cachePath, 'utf8')), now());
        } catch {
          /* first run, or unreadable cache: start empty */
        }
      })();
    }
    return loading;
  }

  /** Write the samples when they changed and the last write is at least 60 s old. */
  async function save(t) {
    if (!dirty || saving || t - lastSaveAt < SAVE_EVERY_MS) return;
    dirty = false;
    saving = true;
    lastSaveAt = t;
    try {
      const airports = base.map((airport) => {
        pruneTracks(airport, t);
        return {
          icao: airport.icao,
          lastPolledAt: airport.lastPolledAt,
          lastOkAt: airport.lastOkAt,
          aircraftNearby: airport.aircraftNearby,
          judged: airport.judged,
          degraded: airport.degraded,
          tracks: [...airport.tracks].map(([hex, track]) => [
            hex,
            track.flight,
            track.points,
          ]),
        };
      });
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      // Write then rename, so a reader (or a crash mid-write) never sees a
      // half-written cache file.
      const tmpPath = `${cachePath}.${process.pid}.tmp`;
      await fsp.writeFile(
        tmpPath,
        JSON.stringify({ savedAt: t, airports }),
        'utf8',
      );
      await fsp.rename(tmpPath, cachePath);
    } catch (err) {
      dirty = true; // retry after the next 60 s window
      console.warn('[airport-watch] cache write failed:', err?.message || err);
    } finally {
      saving = false;
    }
  }

  /** Fold one adsb.lol sample into the airport's tracks and counts. */
  function absorbSample(airport, aircraft, t) {
    const seen = new Set();
    let judged = 0;
    let degraded = 0;
    for (const entry of aircraft) {
      const hex = normalizeHex(entry?.hex);
      if (!hex || seen.has(hex)) continue;
      seen.add(hex);
      const flag = isDegraded(entry);
      if (flag !== null) {
        judged += 1;
        if (flag) degraded += 1;
      }
      if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) continue;
      if (
        Number.isFinite(entry.seen_pos) &&
        entry.seen_pos > MAX_POSITION_AGE_S
      )
        continue;
      if (
        greatCircleKm(airport.lat, airport.lon, entry.lat, entry.lon) >
        TRACK_RANGE_KM
      )
        continue;
      const altFt =
        Number.isFinite(entry.alt_baro) && entry.alt_baro >= 0
          ? entry.alt_baro
          : null;
      let track = airport.tracks.get(hex);
      if (!track) {
        track = { flight: '', points: [] };
        airport.tracks.set(hex, track);
      }
      const flight =
        typeof entry.flight === 'string' ? entry.flight.trim() : '';
      if (flight) track.flight = flight;
      track.points.push({ t, lat: entry.lat, lon: entry.lon, altFt });
    }
    pruneTracks(airport, t);
    airport.aircraftNearby = seen.size;
    airport.judged = judged;
    airport.degraded = degraded;
  }

  async function pollAirport(airport, t) {
    airport.lastPolledAt = t;
    airport.pollTimes = [...airport.pollTimes, t].slice(-RELIABLE_SAMPLES);
    if (base.includes(airport)) lastBasePollAt = t;
    try {
      const upstream = await fetchImpl(
        `https://api.adsb.lol/v2/lat/${airport.lat}/lon/${airport.lon}/dist/${RADIUS_NM}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': WATCHER_USER_AGENT,
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const json = await upstream.json();
      if (!Array.isArray(json?.ac)) throw new Error('unexpected upstream body');
      absorbSample(airport, json.ac, t);
      airport.lastOkAt = t;
      dirty = true;
    } catch (err) {
      airport.backoffUntil = t + BACKOFF_MS;
      if (t - airport.lastLoggedAt >= LOG_EVERY_MS) {
        airport.lastLoggedAt = t;
        console.warn(
          `[airport-watch] ${airport.icao} poll failed (${err?.message || err}); backing off 5 min`,
        );
      }
    }
  }

  /**
   * The priority tier, at most PRIORITY_MAX airports: up to AFFECTED_PRIORITY_MAX
   * watchlist airports rated disrupted (then watch), then viewed airports, most
   * recent request first, to fill the rest.
   */
  function priorityTier(t) {
    const rank = { disrupted: 0, watch: 1 };
    const affected = base
      .map((airport) => ({
        airport,
        rank: rank[airportStatus(airport, t).level],
      }))
      .filter((entry) => entry.rank !== undefined)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, AFFECTED_PRIORITY_MAX)
      .map((entry) => entry.airport);
    const viewed = [...temps].sort((a, b) => b.requestedAt - a.requestedAt);
    return [...affected, ...viewed].slice(0, PRIORITY_MAX);
  }

  /**
   * Next airport of the base rotation that is not backing off, or null. The
   * rotation is the base airports plus the viewed airports outside the priority
   * tier, so each viewed airport is still sampled on the base cycle.
   */
  function nextBase(t, tier) {
    const rotation = [
      ...base,
      ...temps.filter((airport) => !tier.includes(airport)),
    ];
    const count = rotation.length;
    for (let step = 0; step < count; step++) {
      const index = (cursor + step) % count;
      if (rotation[index].backoffUntil <= t) {
        cursor = (index + 1) % count;
        lastBasePollAt = t;
        return rotation[index];
      }
    }
    return null;
  }

  /**
   * One poll per tick (TICK_MS = 10 s):
   *   1. a base airport when the base has had no poll for BASE_FORCE_MS;
   *   2. otherwise the most overdue priority airport, when its last poll is
   *      at least PRIORITY_MS old (about every 60 s each);
   *   3. otherwise the next base airport, round-robin.
   * Resulting rates with four priority airports: 4 priority polls per minute
   * plus 2 base polls per minute, so the 32-airport base cycle takes about 16 min.
   */
  function nextAirport(t) {
    const tier = priorityTier(t);
    if (t - lastBasePollAt >= BASE_FORCE_MS) {
      const forced = nextBase(t, tier);
      if (forced) return forced;
    }
    const due = tier
      .filter((airport) => airport.backoffUntil <= t)
      .filter(
        (airport) =>
          airport.lastPolledAt === null ||
          t - airport.lastPolledAt >= PRIORITY_MS,
      )
      .sort((a, b) => {
        const x = a.lastPolledAt ?? -Infinity;
        const y = b.lastPolledAt ?? -Infinity;
        return x === y ? 0 : x < y ? -1 : 1;
      });
    if (due.length > 0) return due[0];
    return nextBase(t, tier);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const t = now();
      if (t - lastRequestAt > IDLE_MS) {
        stop();
        void save(t);
        return;
      }
      pruneTemps(t);
      const airport = nextAirport(t);
      if (airport) await pollAirport(airport, t);
      // Not awaited: a slow disk must not hold the next poll. save() guards
      // itself against overlap and never throws.
      void save(now());
    } finally {
      busy = false;
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Start the poll timer if idle; the first poll runs immediately. */
  function activate() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/airports/status', async (req, res) => {
      const send = (status, obj) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const url = new URL(String(req.url || ''), 'http://localhost');
        if (url.pathname !== '/')
          return send(404, { error: 'unknown endpoint' });
        const query = parseAirportCodes(url.searchParams.get('codes'));
        if (query.error) return send(400, { error: query.error });

        await loadOnce();
        const t = now();
        lastRequestAt = t;
        addTemps(query.codes, t);
        activate();
        pruneTemps(t);

        // A viewed airport outside the priority tier is only sampled on the
        // base rotation, so its holding is never reliable.
        const tier = priorityTier(t);
        return send(200, {
          generatedAt: t,
          airports: rotation().map((airport) =>
            airportStatus(airport, t, {
              assessable: base.includes(airport) || tier.includes(airport),
            }),
          ),
          method: AIRPORT_WATCH_METHOD,
          note: AIRPORT_WATCH_NOTE,
          source: AIRPORT_WATCH_SOURCE,
        });
      } catch (err) {
        console.error('[airport-watch] request failed:', err?.message || err);
        return send(500, { error: 'airport status proxy error' });
      }
    });
  };
  return {
    name: 'airport-watch-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
