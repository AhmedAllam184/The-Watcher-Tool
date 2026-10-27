/**
 * GDELT Event Database 2.0, read from the 15-minute export files. This module
 * is pure: parsing, the CAMEO filter, per-file grouping and the rolling store.
 * The network and the timing live in gdeltFeed.js.
 *
 * Each file is one 15-minute slice of events added to GDELT, one tab-separated
 * row per event with 61 fields and no header. A row is kept only when it is
 * material conflict (QuadClass 4) with root code 18 (assault), 19 (fight) or 20
 * (unconventional mass violence) and has a point location. Rows are grouped per
 * file by location (3 decimals) and type; a group is kept when at least
 * MIN_ARTICLES articles or sources report it. Groups are merged across the
 * requested window when the store is queried.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const GDELT_STEP_MS = 15 * 60_000;
/** A group needs this many articles, or this many sources, to be kept. */
export const MIN_ARTICLES = 2;
export const GDELT_STORE_CAP = 50_000;
export const GDELT_RETENTION_MS = 7 * DAY_MS;
export const GDELT_COLUMN_COUNT = 61;

/**
 * 0-based column indices of the GDELT 2.0 Event export, from the codebook.
 * Keep these in step with the codebook when it changes; the parser reads only
 * the columns named here.
 */
export const GDELT_COLUMNS = Object.freeze({
  GLOBALEVENTID: 0,
  SQLDATE: 1, // YYYYMMDD, the event date (not used: points are dated by DATEADDED)
  Actor1Name: 6,
  Actor1CountryCode: 7,
  Actor2Name: 16,
  Actor2CountryCode: 17,
  IsRootEvent: 25,
  EventCode: 26, // CAMEO event code, 3 or 4 digits
  EventBaseCode: 27,
  EventRootCode: 28,
  QuadClass: 29, // 1 verbal cooperation, 2 material cooperation, 3 verbal conflict, 4 material conflict
  GoldsteinScale: 30,
  NumMentions: 31,
  NumSources: 32,
  NumArticles: 33,
  AvgTone: 34,
  ActionGeo_Type: 51, // 1 country, 2 US state, 3 US city, 4 world city, 5 world state
  ActionGeo_FullName: 52,
  ActionGeo_CountryCode: 53,
  ActionGeo_Lat: 56,
  ActionGeo_Long: 57,
  DATEADDED: 59, // YYYYMMDDHHMMSS, when GDELT added the event
  SOURCEURL: 60,
});

/** Root codes kept: 18 assault, 19 fight, 20 unconventional mass violence. */
export const GDELT_ROOT_CODES = Object.freeze(['18', '19', '20']);
const MATERIAL_CONFLICT = '4';
/** ActionGeo_Type 1 is a country centroid: too coarse for a point. */
const COUNTRY_GEO_TYPE = 1;

const finiteNumber = (value) => {
  if (value === null || value === undefined || String(value).trim() === '')
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const count = (value) => Math.max(0, Math.round(finiteNumber(value) ?? 0));

/** A web link (http or https) or null. */
function httpUrl(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

const hostOf = (href) => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Milliseconds of a 14-digit GDELT stamp (YYYYMMDDHHMMSS, UTC), or null. */
export function gdeltStampMs(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    String(stamp ?? '').trim(),
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  )
    return null;
  return ms;
}

/** The 14-digit GDELT stamp of a UTC time, as used in file names. */
export function gdeltStampFromMs(ms) {
  return new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);
}

/**
 * The newest export file from lastupdate.txt ("<size> <md5> <url>" lines), or
 * null when no line names an export file. Only the stamp is used: file URLs
 * are rebuilt from the host that answered.
 * @returns {?{stampMs: number}}
 */
export function parseLastUpdate(text) {
  let newest = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /\/(\d{14})\.export\.CSV\.zip\s*$/.exec(line);
    if (!match) continue;
    const ms = gdeltStampMs(match[1]);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest === null ? null : { stampMs: newest };
}

/**
 * CAMEO event code → the plain type shown to people. Specific codes come
 * first; the rest fall back to their root (19x fighting, 18x assault, 20x mass
 * violence). Null for codes outside the kept roots.
 */
export function gdeltEventType(eventCode) {
  const code = String(eventCode ?? '').trim();
  if (code === '195' || code === '1951' || code === '1952')
    return 'Airstrike / aerial weapons';
  if (code === '194') return 'Artillery / tank fire';
  if (['190', '191', '192', '193'].includes(code)) return 'Armed clash';
  if (['183', '1831', '1832', '1833', '1834'].includes(code)) return 'Bombing';
  if (code === '186') return 'Assassination';
  if (['180', '181', '182', '184', '185'].includes(code)) return 'Assault';
  if (code.startsWith('20')) return 'Mass violence';
  if (code.startsWith('19')) return 'Fighting';
  if (code.startsWith('18')) return 'Assault';
  return null;
}

/**
 * One export row → an event, or null when it is outside the kept conflict
 * classes, has no usable point, or is a country-level location.
 * @param {string[]} fields - the row split on tabs.
 */
export function gdeltEventFromFields(fields) {
  const C = GDELT_COLUMNS;
  if (!Array.isArray(fields) || fields.length < GDELT_COLUMN_COUNT) return null;
  if (String(fields[C.QuadClass]).trim() !== MATERIAL_CONFLICT) return null;
  if (!GDELT_ROOT_CODES.includes(String(fields[C.EventRootCode]).trim()))
    return null;
  if (Number(fields[C.ActionGeo_Type]) === COUNTRY_GEO_TYPE) return null;
  const lat = finiteNumber(fields[C.ActionGeo_Lat]);
  const lon = finiteNumber(fields[C.ActionGeo_Long]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  const id = String(fields[C.GLOBALEVENTID]).trim();
  if (!/^\d+$/.test(id)) return null;
  const type = gdeltEventType(fields[C.EventCode]);
  const addedMs = gdeltStampMs(fields[C.DATEADDED]);
  if (!type || addedMs === null) return null;
  const url = httpUrl(fields[C.SOURCEURL]);
  const actors = [fields[C.Actor1Name], fields[C.Actor2Name]]
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  return {
    id,
    type,
    lat: Number(lat.toFixed(3)),
    lon: Number(lon.toFixed(3)),
    t: addedMs,
    location:
      String(fields[C.ActionGeo_FullName] ?? '')
        .trim()
        .slice(0, 180) || null,
    actors,
    articles: count(fields[C.NumArticles]),
    mentions: count(fields[C.NumMentions]),
    sources: count(fields[C.NumSources]),
    url,
  };
}

/** The kept events of one export file. A GLOBALEVENTID keeps its first row. */
export function gdeltEventsFromExport(text) {
  const seen = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    const event = gdeltEventFromFields(line.replace(/\r$/, '').split('\t'));
    if (event && !seen.has(event.id)) seen.set(event.id, event);
  }
  return [...seen.values()];
}

/**
 * Group one file's events into points by type and rounded location. A point
 * is kept when it has MIN_ARTICLES articles or MIN_ARTICLES sources.
 */
export function gdeltPointsFromEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${event.type}|${event.lat}|${event.lon}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        type: event.type,
        lat: event.lat,
        lon: event.lon,
        t: event.t,
        location: event.location,
        articles: 0,
        mentions: 0,
        sources: 0,
        url: null,
        urlArticles: -1,
        actors: new Map(),
      };
      groups.set(key, group);
    }
    group.articles += event.articles;
    group.mentions += event.mentions;
    group.sources += event.sources;
    if (event.t >= group.t) {
      group.t = event.t;
      group.location = event.location ?? group.location;
    }
    if (event.url && event.articles > group.urlArticles) {
      group.url = event.url;
      group.urlArticles = event.articles;
    }
    for (const name of event.actors)
      group.actors.set(name, (group.actors.get(name) ?? 0) + event.articles);
  }
  const points = [];
  for (const group of groups.values()) {
    if (group.articles < MIN_ARTICLES && group.sources < MIN_ARTICLES) continue;
    const actors = [...group.actors]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([name, weight]) => ({ name, n: weight }));
    points.push({
      key: group.key,
      type: group.type,
      lat: group.lat,
      lon: group.lon,
      t: group.t,
      location: group.location,
      articles: group.articles,
      mentions: group.mentions,
      sources: group.sources,
      url: group.url,
      urlArticles: Math.max(0, group.urlArticles),
      actors,
    });
  }
  return points;
}

/** Points for one export file's text. */
export function gdeltPointsFromExport(text) {
  return gdeltPointsFromEvents(gdeltEventsFromExport(text));
}

/** "Khan Yunis, Gaza Strip, Palestinian Territory" → "Khan Yunis, Palestinian Territory". */
export function placeName(location) {
  const parts = String(location ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'Unnamed location';
  const last = parts[parts.length - 1];
  return parts.length > 1 && last !== parts[0]
    ? `${parts[0]}, ${last}`
    : parts[0];
}

const slug = (text) => text.toLowerCase().replace(/[^a-z]+/g, '-');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Points inside an {west,south,east,north} box, or any point without one. */
function insideBox(point, bbox) {
  if (!bbox) return true;
  const [west, south, east, north] = bbox;
  return (
    point.lon >= west &&
    point.lon <= east &&
    point.lat >= south &&
    point.lat <= north
  );
}

/** Whether a stored point has the shape written by this module. */
export function isStoredPoint(value) {
  return (
    value &&
    typeof value.key === 'string' &&
    typeof value.type === 'string' &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lon) &&
    Number.isFinite(value.t) &&
    Number.isFinite(value.articles) &&
    Number.isFinite(value.sources) &&
    Array.isArray(value.actors)
  );
}

/**
 * The rolling store of per-file points. Files are identified by their time in
 * ms, and a file is recorded once so it is never downloaded twice. Points
 * older than the retention are pruned; past the cap, the oldest go first.
 */
export function createGdeltStore({
  cap = GDELT_STORE_CAP,
  retentionMs = GDELT_RETENTION_MS,
} = {}) {
  let points = [];
  const processed = new Set();

  function prune(nowMs) {
    const floor = nowMs - retentionMs;
    points = points.filter((point) => point.t >= floor);
    for (const fileMs of processed)
      if (fileMs < floor) processed.delete(fileMs);
    if (points.length > cap) {
      points.sort((a, b) => b.t - a.t);
      points.length = cap;
    }
  }

  return {
    /** Whether a file time has been recorded. */
    has(fileMs) {
      return processed.has(fileMs);
    },
    /** Record one file's points (possibly none) as processed. */
    addFile(fileMs, filePoints, nowMs) {
      processed.add(fileMs);
      for (const point of filePoints) points.push(point);
      prune(nowMs);
    },
    /** Number of recorded files at or after a time. */
    filesSince(sinceMs) {
      let total = 0;
      for (const fileMs of processed) if (fileMs >= sinceMs) total += 1;
      return total;
    },
    /** Earliest recorded file time at or after sinceMs, or null. */
    earliestSince(sinceMs) {
      let earliest = null;
      for (const fileMs of processed)
        if (fileMs >= sinceMs && (earliest === null || fileMs < earliest))
          earliest = fileMs;
      return earliest;
    },
    /** Hours of recorded files from the window start, to one decimal, capped at the window. */
    coverageHours(nowMs, windowMs) {
      const earliest = this.earliestSince(nowMs - windowMs);
      if (earliest === null) return 0;
      const hours =
        Math.min(windowMs, nowMs - earliest + GDELT_STEP_MS) / HOUR_MS;
      return Math.round(hours * 10) / 10;
    },
    /**
     * Events for a window: points merged by type and location, with articles
     * summed, the most-cited link kept, and the two most frequent actors.
     * @param {{sinceMs: number, bbox?: ?number[]}} query - bbox is [w,s,e,n].
     */
    query({ sinceMs, bbox = null }) {
      const groups = new Map();
      for (const point of points) {
        if (point.t < sinceMs || !insideBox(point, bbox)) continue;
        let group = groups.get(point.key);
        if (!group) {
          group = {
            key: point.key,
            type: point.type,
            lat: point.lat,
            lon: point.lon,
            t: point.t,
            location: point.location,
            articles: 0,
            url: null,
            urlArticles: -1,
            actors: new Map(),
          };
          groups.set(point.key, group);
        }
        group.articles += point.articles;
        if (point.t >= group.t) {
          group.t = point.t;
          group.location = point.location ?? group.location;
        }
        if (point.url && point.urlArticles > group.urlArticles) {
          group.url = point.url;
          group.urlArticles = point.urlArticles;
        }
        for (const actor of point.actors)
          group.actors.set(
            actor.name,
            (group.actors.get(actor.name) ?? 0) + actor.n,
          );
      }
      return [...groups.values()].map((group) => {
        const actors = [...group.actors]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 2)
          .map(([name]) => name);
        const place = placeName(group.location);
        const host = group.url ? hostOf(group.url) : null;
        return {
          id: `gdelt:${group.lat.toFixed(3)}:${group.lon.toFixed(3)}:${slug(group.type)}`,
          lat: group.lat,
          lon: group.lon,
          date: isoDay(group.t),
          type: group.type,
          articles: group.articles,
          actors,
          country: null,
          location: group.location || place,
          title: `${group.type} · ${place}`.slice(0, 180),
          ...(group.url ? { url: group.url } : {}),
          ...(host ? { sourceName: host } : {}),
        };
      });
    },
    /** The persisted form: recorded file times and the stored points. */
    toJSON() {
      return { processed: [...processed].sort((a, b) => a - b), points };
    },
    /** Load a persisted form, keeping only valid entries inside the retention. */
    restore(value, nowMs) {
      const floor = nowMs - retentionMs;
      processed.clear();
      for (const fileMs of Array.isArray(value?.processed)
        ? value.processed
        : [])
        if (Number.isFinite(fileMs) && fileMs >= floor) processed.add(fileMs);
      points = (Array.isArray(value?.points) ? value.points : []).filter(
        (point) => isStoredPoint(point) && point.t >= floor,
      );
      prune(nowMs);
    },
    get pointCount() {
      return points.length;
    },
  };
}
