import { isRecognizedAisEnvelope } from '../../../src/data/aisStreamAdapter.js';
export const AISSTREAM_CACHE_MAX = 50000;
export const AISSTREAM_STALE_MS = 30 * 60 * 1000;
// Per-MMSI recent-path ring buffers (PRD WS-F F3). Float32 lat/lon (~1m
// precision, fine for 25m thinning) + Uint32 epoch seconds ≈ 12B/sample;
// 64 samples × 50k MMSIs worst case ≈ 38MB. Tracks exist only while the dev
// server runs — this is "recent path", not voyage history.
const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;
/** @type {Map<string,object>} */
const _aisStreamVessels = new Map();
/** @type {Map<string,object>} */
const _aisStreamStatic = new Map();
/** @type {Map<string,{lats:Float32Array,lons:Float32Array,times:Uint32Array,head:number,len:number}>} mmsi -> track ring buffer */
const _aisStreamTracks = new Map();
/** @type {Map<string,{lat:number,lon:number,epochSec:number}>} mmsi -> first fix awaiting second (lazy buffer allocation) */
const _aisStreamTrackPending = new Map();
// Dark-vessel memory: a moving vessel that goes quiet is remembered here when
// it is pruned from the live cache, so darkVessels() can still judge it after
// the 30-min live window closes. Bounded in time and count.
const AIS_DARK_MEMORY_TTL_MS = 6 * 3_600_000;
const AIS_DARK_MEMORY_MAX = 5_000;
const AIS_DARK_MIN_SPEED_KT = 3;
const AIS_DARK_MIN_REPORTS = 3;
/** @type {Map<string,object>} mmsi -> last live fields, lastSeenMs and reportCount */
const _aisDarkMemory = new Map();

/**
 * Store one parsed AIS envelope.
 *
 * The return value is the feed's ONLY liveness proof, so it is true strictly
 * when the envelope carried a real AIS record. Malformed frames and error
 * envelopes never reach here — the adapter classifies those — and a JSON
 * object without an MMSI proves nothing about the feed.
 *
 * @param {Object} envelope Parsed, non-error AIS envelope.
 * @returns {boolean} True when an AIS record was recognised.
 */
export function ingestAisStreamEnvelope(envelope) {
  // Single shared recognition rule (also used by the adapter's tests), so the
  // liveness predicate that ships is the one under test. An envelope carrying
  // only an MMSI is not proof the feed works.
  if (!isRecognizedAisEnvelope(envelope)) return false;

  const messageType = envelope?.MessageType;
  const message = envelope?.Message?.[messageType] || {};
  const metadata = envelope?.MetaData || envelope?.Metadata || {};
  const mmsi = stringValue(
    metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi,
  );
  if (!mmsi) return false;

  // Any accepted report means the transponder is transmitting again, so the
  // vessel is no longer a dark memory. Its count is kept for the live row.
  const returning = _aisDarkMemory.get(mmsi);
  _aisDarkMemory.delete(mmsi);

  if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
    const staticData = {
      name: vesselNameFromAis(metadata, message, _aisStreamStatic.get(mmsi)),
      type: vesselTypeFromAis(message, _aisStreamStatic.get(mmsi)),
      destination: stringValue(message.Destination),
      imo: stringValue(message.ImoNumber ?? message.IMO),
    };
    _aisStreamStatic.set(mmsi, staticData);
    mergeAisStaticIntoLiveVessel(mmsi, staticData);
  }

  const lat = numberValue(
    metadata.latitude ?? metadata.Latitude ?? message.Latitude,
  );
  const lon = numberValue(
    metadata.longitude ?? metadata.Longitude ?? message.Longitude,
  );
  // A positionless but well-formed record (static data) is still the feed
  // delivering AIS traffic, so it counts as liveness.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;

  const staticData = _aisStreamStatic.get(mmsi) || {};
  const previous = _aisStreamVessels.get(mmsi);
  _aisStreamVessels.set(mmsi, {
    lat,
    lon,
    name: vesselNameFromAis(metadata, message, staticData) || `MMSI ${mmsi}`,
    mmsi,
    imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData.imo),
    type: vesselTypeFromAis(message, staticData),
    destination: stringValue(message.Destination ?? staticData.destination),
    speed: normalizedSpeedOverGround(message.Sog ?? message.SOG),
    course: normalizedCourseOverGround(message.Cog ?? message.COG),
    heading: normalizedHeading(message.TrueHeading ?? message.Heading),
    last_position_UTC: normalizeAisTimestamp(
      metadata.time_utc ?? metadata.TimeUtc,
    ),
    // Use the AIS message's own report time, not server ingest wall-clock —
    // trail spacing and dead reckoning depend on true fix epochs.
    last_position_epoch: aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
    _updatedAt: Date.now(),
    _reportCount: (previous?._reportCount ?? returning?.reportCount ?? 0) + 1,
  });

  appendAisTrackSample(
    mmsi,
    lat,
    lon,
    aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc),
  );

  pruneAisStreamCache();
  return true;
}

/**
 * Parses an AISStream UTC timestamp into epoch seconds (fallback: now).
 */
function aisEpochSeconds(value) {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms)
    ? Math.floor(ms / 1000)
    : Math.floor(Date.now() / 1000);
}

/**
 * Appends a thinned position sample to a vessel's track ring buffer.
 * Buffers allocate lazily on the second fix (most MMSIs are seen once);
 * samples are kept only when >=AIS_TRACK_MIN_GAP_SEC and
 * >=AIS_TRACK_MIN_MOVE_M from the previous stored sample, so anchored
 * vessels collapse to a single point.
 */
function appendAisTrackSample(mmsi, lat, lon, epochSec) {
  let track = _aisStreamTracks.get(mmsi);
  if (!track) {
    const pending = _aisStreamTrackPending.get(mmsi);
    if (!pending) {
      _aisStreamTrackPending.set(mmsi, { lat, lon, epochSec });
      return;
    }
    if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
    if (
      approxMetersBetween(pending.lat, pending.lon, lat, lon) <
      AIS_TRACK_MIN_MOVE_M
    )
      return;
    track = {
      lats: new Float32Array(AIS_TRACK_SAMPLES),
      lons: new Float32Array(AIS_TRACK_SAMPLES),
      times: new Uint32Array(AIS_TRACK_SAMPLES),
      head: 0,
      len: 0,
    };
    _aisStreamTracks.set(mmsi, track);
    _aisStreamTrackPending.delete(mmsi);
    writeAisTrackSample(track, pending.lat, pending.lon, pending.epochSec);
    writeAisTrackSample(track, lat, lon, epochSec);
    return;
  }

  const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  const lastEpoch = track.times[lastIdx];
  if (epochSec - lastEpoch < AIS_TRACK_MIN_GAP_SEC) return;
  if (
    approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) <
    AIS_TRACK_MIN_MOVE_M
  )
    return;
  writeAisTrackSample(track, lat, lon, epochSec);
}

function writeAisTrackSample(track, lat, lon, epochSec) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

/**
 * Reads a vessel's accumulated track in chronological order.
 * @returns {Array<{lat:number,lon:number,t:number}>}
 */
export function readAisTrack(mmsi) {
  const track = _aisStreamTracks.get(mmsi);
  if (!track || !track.len) return [];
  const samples = [];
  const start =
    (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
  for (let i = 0; i < track.len; i++) {
    const idx = (start + i) % AIS_TRACK_SAMPLES;
    samples.push({
      lat: track.lats[idx],
      lon: track.lons[idx],
      t: track.times[idx],
    });
  }
  return samples;
}

/** Equirectangular distance approximation — plenty for 25m thinning. */
function approxMetersBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111320;
  const dLon =
    (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function mergeAisStaticIntoLiveVessel(mmsi, staticData) {
  const existing = _aisStreamVessels.get(mmsi);
  if (!existing) return;
  if (staticData.name && (!existing.name || existing.name === `MMSI ${mmsi}`))
    existing.name = staticData.name;
  if (staticData.type && !existing.type) existing.type = staticData.type;
  if (staticData.destination && !existing.destination)
    existing.destination = staticData.destination;
  if (staticData.imo && !existing.imo) existing.imo = staticData.imo;
}

function vesselNameFromAis(metadata, message, staticData = {}) {
  return stringValue(
    metadata.ShipName ??
      message.Name ??
      message.ShipName ??
      message.ReportA?.Name ??
      staticData.name,
  );
}

function vesselTypeFromAis(message, staticData = {}) {
  return stringValue(
    message.Type ??
      message.ShipType ??
      message.ReportB?.ShipType ??
      staticData.type,
  );
}

export function aisStreamRows(maxRows) {
  const cutoff = Date.now() - AISSTREAM_STALE_MS;
  const rows = [];
  for (const row of _aisStreamVessels.values()) {
    if (row._updatedAt >= cutoff) rows.push(row);
  }
  rows.sort((a, b) => b._updatedAt - a._updatedAt);
  return rows
    .slice(0, maxRows)
    .map(({ _updatedAt, _reportCount, ...row }) => row);
}

/**
 * Whether a row is worth remembering when it goes stale: it was under way and
 * had reported enough to be more than a one-off sighting.
 */
function isAisDarkCandidate(row) {
  return (
    Number.isFinite(row.lat) &&
    Number.isFinite(row.lon) &&
    Number.isFinite(row.speed) &&
    row.speed >= AIS_DARK_MIN_SPEED_KT &&
    row._reportCount >= AIS_DARK_MIN_REPORTS
  );
}

function pruneAisStreamCache() {
  const now = Date.now();
  const cutoff = now - AISSTREAM_STALE_MS;
  for (const [mmsi, row] of _aisStreamVessels) {
    if (row._updatedAt < cutoff) {
      if (isAisDarkCandidate(row)) {
        const { _updatedAt, _reportCount, ...fields } = row;
        _aisDarkMemory.set(mmsi, {
          ...fields,
          lastSeenMs: _updatedAt,
          reportCount: _reportCount,
        });
      }
      _aisStreamVessels.delete(mmsi);
      _aisStreamTracks.delete(mmsi);
      _aisStreamTrackPending.delete(mmsi);
    }
  }
  const darkCutoff = now - AIS_DARK_MEMORY_TTL_MS;
  for (const [mmsi, entry] of _aisDarkMemory) {
    if (entry.lastSeenMs < darkCutoff) _aisDarkMemory.delete(mmsi);
  }
  if (_aisDarkMemory.size > AIS_DARK_MEMORY_MAX) {
    const oldest = [..._aisDarkMemory.entries()].sort(
      (a, b) => a[1].lastSeenMs - b[1].lastSeenMs,
    );
    for (const [mmsi] of oldest.slice(
      0,
      _aisDarkMemory.size - AIS_DARK_MEMORY_MAX,
    ))
      _aisDarkMemory.delete(mmsi);
  }
  // Pending single-fix entries for vessels never seen again must not leak
  const pendingCutoffSec = Math.floor(cutoff / 1000);
  for (const [mmsi, pending] of _aisStreamTrackPending) {
    if (pending.epochSec < pendingCutoffSec)
      _aisStreamTrackPending.delete(mmsi);
  }
  if (_aisStreamVessels.size <= AISSTREAM_CACHE_MAX) return;
  const ordered = [..._aisStreamVessels.entries()].sort(
    (a, b) => a[1]._updatedAt - b[1]._updatedAt,
  );
  for (const [mmsi] of ordered.slice(
    0,
    _aisStreamVessels.size - AISSTREAM_CACHE_MAX,
  )) {
    _aisStreamVessels.delete(mmsi);
    _aisStreamTracks.delete(mmsi);
    _aisStreamTrackPending.delete(mmsi);
  }
}

export function newestAisPositionAt(rows) {
  return rows[0]?.last_position_UTC || null;
}

const DARK_FEED_FRESH_MS = 5 * 60_000;
const DARK_RESULT_MAX = 500;
const DARK_NOTE =
  'Inference only, not an observed fault. Neighbours reporting nearby show that receivers work there; they do not prove the transponder on that vessel is off.';

/**
 * Infer which vessels have gone dark: still under way when last heard, but
 * silent since, while the AIS coverage around their last position is still
 * demonstrably working. Silence alone is never enough, because AISStream is
 * mostly terrestrial and ships routinely leave receiver range. Every result is
 * an inference.
 *
 * @param {Object} [options]
 * @param {number} [options.now] Reference time, epoch ms.
 * @param {number} [options.minSilenceMs] Minimum silence before a vessel counts.
 * @param {number} [options.maxSilenceMs] Silence beyond which memory is ignored.
 * @param {number} [options.minSpeedKt] Speed at last report that counts as under way.
 * @param {number} [options.minReports] Reports needed to rule out a one-off sighting.
 * @param {number} [options.cellDeg] Coverage cell size in degrees.
 * @param {number} [options.neighbourWindowMs] How recent a neighbour must be.
 * @param {number} [options.minNeighbours] Other vessels needed to prove coverage.
 * @param {number|null} [options.feedLastMessageAt] Epoch ms of the last feed message.
 * @returns {{generatedAt:number,feedHealthy:boolean,rule:object,note:string,count:number,vessels:object[]}}
 */
export function darkVessels({
  now = Date.now(),
  minSilenceMs = 20 * 60_000,
  maxSilenceMs = AIS_DARK_MEMORY_TTL_MS,
  minSpeedKt = AIS_DARK_MIN_SPEED_KT,
  minReports = AIS_DARK_MIN_REPORTS,
  cellDeg = 1,
  neighbourWindowMs = 10 * 60_000,
  minNeighbours = 3,
  feedLastMessageAt = null,
} = {}) {
  // An outage looks exactly like a fleet going quiet, so a stale feed reports
  // nothing rather than a false fleet-wide dark event.
  const feedHealthy =
    Number.isFinite(feedLastMessageAt) &&
    now - feedLastMessageAt <= DARK_FEED_FRESH_MS;
  const result = {
    generatedAt: now,
    feedHealthy,
    rule: {
      minSilenceMin: minSilenceMs / 60_000,
      minSpeedKt,
      minReports,
      coverage: `at least ${minNeighbours} other vessels reported within the last ${neighbourWindowMs / 60_000} min in the same or adjacent ${cellDeg}° cell`,
    },
    note: DARK_NOTE,
    count: 0,
    vessels: [],
  };
  if (!feedHealthy) return result;

  // Coverage index: which fresh vessels sit in which 1° cell. Longitude wraps
  // at the antimeridian so cells on either side of ±180 count as adjacent.
  const cols = Math.round(360 / cellDeg);
  const minCol = Math.floor(-180 / cellDeg);
  const wrapCol = (col) => minCol + ((((col - minCol) % cols) + cols) % cols);
  const cellKey = (lat, lon) =>
    `${Math.floor(lat / cellDeg)}:${wrapCol(Math.floor(lon / cellDeg))}`;
  /** @type {Map<string,string[]>} */
  const cells = new Map();
  for (const row of _aisStreamVessels.values()) {
    if (now - row._updatedAt > neighbourWindowMs) continue;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
    const key = cellKey(row.lat, row.lon);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row.mmsi);
  }
  const neighbourCount = (lat, lon, self) => {
    const r = Math.floor(lat / cellDeg);
    const c = Math.floor(lon / cellDeg);
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const mmsi of cells.get(`${r + dr}:${wrapCol(c + dc)}`) || []) {
          if (mmsi !== self) count++;
        }
      }
    }
    return count;
  };

  // Live rows past the silence threshold, plus pruned dark memories.
  const candidates = [];
  for (const row of _aisStreamVessels.values()) {
    const silentMs = now - row._updatedAt;
    if (silentMs < minSilenceMs || silentMs >= AISSTREAM_STALE_MS) continue;
    const { _updatedAt, _reportCount, ...fields } = row;
    candidates.push({
      ...fields,
      lastSeenMs: _updatedAt,
      reportCount: _reportCount,
      silentMs,
    });
  }
  for (const entry of _aisDarkMemory.values()) {
    const silentMs = now - entry.lastSeenMs;
    if (silentMs < minSilenceMs || silentMs > maxSilenceMs) continue;
    candidates.push({ ...entry, silentMs });
  }

  const matched = [];
  for (const candidate of candidates) {
    if (
      !Number.isFinite(candidate.lat) ||
      !Number.isFinite(candidate.lon) ||
      !Number.isFinite(candidate.speed) ||
      candidate.speed < minSpeedKt ||
      candidate.reportCount < minReports
    )
      continue;
    const neighbours = neighbourCount(
      candidate.lat,
      candidate.lon,
      candidate.mmsi,
    );
    if (neighbours < minNeighbours) continue;
    const silentMin = Math.round(candidate.silentMs / 60_000);
    matched.push({
      mmsi: candidate.mmsi,
      name: candidate.name,
      type: candidate.type,
      imo: candidate.imo,
      destination: candidate.destination,
      lat: candidate.lat,
      lon: candidate.lon,
      lastSpeedKt: candidate.speed,
      course: candidate.course,
      heading: candidate.heading,
      lastSeenMs: candidate.lastSeenMs,
      silentMs: candidate.silentMs,
      neighbours,
      inference: `No AIS for ${silentMin} min while under way at ${candidate.speed.toFixed(1)} kt; ${neighbours} other vessels nearby still reporting`,
    });
  }
  matched.sort((a, b) => a.silentMs - b.silentMs);
  result.count = matched.length;
  result.vessels = matched.slice(0, DARK_RESULT_MAX);
  return result;
}

/** Test-only: empty every store map so each test starts from a clean feed. */
export function __resetAisStoreForTests() {
  _aisStreamVessels.clear();
  _aisStreamStatic.clear();
  _aisStreamTracks.clear();
  _aisStreamTrackPending.clear();
  _aisDarkMemory.clear();
}

/** Test-only: number of remembered dark vessels. */
export function __aisDarkMemorySizeForTests() {
  return _aisDarkMemory.size;
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedHeading(value) {
  const heading = numberValue(value);
  return heading !== null && heading >= 0 && heading <= 360 ? heading : null;
}

/**
 * Speed over ground in knots, or null when the report carries AIS's "not
 * available" code. ITU-R M.1371 encodes SOG in 0.1-knot units where 1022 means
 * "102.2 knots or higher" and 1023 means unavailable, so 102.3 is a sentinel
 * and not a reading. It is finite, so every consumer would otherwise treat it
 * as a genuine speed.
 */
function normalizedSpeedOverGround(value) {
  const speed = numberValue(value);
  return speed !== null && speed >= 0 && speed < 102.3 ? speed : null;
}

/**
 * Course over ground in degrees, or null when the report carries AIS's "not
 * available" code (3600 in 0.1-degree units, i.e. 360). Valid courses stop at
 * 359.9; heading keeps its own separate sentinel of 511.
 */
function normalizedCourseOverGround(value) {
  const course = numberValue(value);
  return course !== null && course >= 0 && course < 360 ? course : null;
}

function normalizeAisTimestamp(value) {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}
