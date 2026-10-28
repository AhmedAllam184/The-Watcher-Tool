import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { WATCHER_USER_AGENT } from './common/userAgent.js';
/**
 * Identify proxy: a Wikipedia summary, image and article link for a named
 * aircraft type or satellite programme. GET /api/identify?q=<query>&kind=aircraft|satellite.
 * The query is the name the browser already resolved (for example "IAI Heron
 * aircraft" or "Starlink"); the top Wikipedia search result supplies the text.
 * Answers are cached on disk: a found article for 30 days, a "no article"
 * answer for 7 days. Upstream failures are never cached: with nothing stored
 * the answer is 503, and a stored answer is served stale. At most 2,000
 * entries are kept; the oldest by time are evicted first.
 */
const HIT_TTL_MS = 30 * 24 * 3600_000;
const MISS_TTL_MS = 7 * 24 * 3600_000;
const MAX_ENTRIES = 2000;
const UPSTREAM_TIMEOUT_MS = 8000;
const SUMMARY_SENTENCES = 3;
const SUMMARY_MAX_CHARS = 600;
const KINDS = new Set(['aircraft', 'satellite']);
/** Letters, digits, spaces and a few punctuation marks, 2 to 80 characters. */
const QUERY_PATTERN = /^[\p{L}\p{N} .\-()/&']{2,80}$/u;

/** Only https URLs reach the browser. */
function httpsUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Wikimedia image URLs only: https on upload.wikimedia.org. */
function wikimediaImageUrl(value) {
  const url = httpsUrl(value);
  if (!url) return null;
  return new URL(url).hostname === 'upload.wikimedia.org' ? url : null;
}

/** The query text the route accepts (trimmed, spaces collapsed), or null. */
export function parseIdentifyQuery(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return QUERY_PATTERN.test(text) ? text : null;
}

/** Up to three sentences and a length cap, on whitespace-normalised text. */
export function trimSummary(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [flat];
  let summary = sentences
    .slice(0, SUMMARY_SENTENCES)
    .map((sentence) => sentence.trim())
    .join(' ');
  if (summary.length > SUMMARY_MAX_CHARS)
    summary = `${summary.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  return summary;
}

/** The Wikipedia search URL: the best-matching article's summary, thumbnail and link. */
export function wikipediaSearchUrl(query) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '1',
    prop: 'pageimages|extracts|info',
    piprop: 'thumbnail',
    pithumbsize: '640',
    exintro: '1',
    explaintext: '1',
    exsentences: String(SUMMARY_SENTENCES),
    inprop: 'url',
  });
  return `https://en.wikipedia.org/w/api.php?${params}`;
}

/** The article from a search answer, or null when there is none. */
export function parseWikipediaArticle(json) {
  const page = Array.isArray(json?.query?.pages) ? json.query.pages[0] : null;
  if (!page || page.missing === true) return null;
  const title =
    typeof page.title === 'string' && page.title.trim()
      ? page.title.trim()
      : null;
  const summary = trimSummary(page.extract);
  if (!title || !summary) return null;
  return {
    title,
    summary,
    image: wikimediaImageUrl(page.thumbnail?.source),
    link: httpsUrl(page.fullurl),
  };
}

export function identifyProxy({
  fetchImpl = globalThis.fetch,
  cachePath = path.join(process.cwd(), '.gev-cache', 'identify.json'),
} = {}) {
  let cache = {};
  let dirty = false;
  let saving = false;
  /** The one disk read; every caller awaits the same promise. */
  let loading = null;
  const inflight = new Map();

  const ttlFor = (entry) => (entry?.data ? HIT_TTL_MS : MISS_TTL_MS);
  const fresh = (entry) => entry && Date.now() - entry.at < ttlFor(entry);

  /** Keep the newest MAX_ENTRIES in memory; the oldest by `at` go first. */
  function enforceCap() {
    const keys = Object.keys(cache);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES))
      delete cache[key];
  }

  /** Write temp-then-rename, so a crash mid-write never leaves a partial file. */
  async function save() {
    if (!dirty || saving) return;
    dirty = false;
    saving = true;
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    try {
      const entries = Object.entries(cache)
        .filter(([, entry]) => fresh(entry))
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, MAX_ENTRIES);
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(
        tmpPath,
        JSON.stringify({ articles: Object.fromEntries(entries) }),
        'utf8',
      );
      await fsp.rename(tmpPath, cachePath);
    } catch {
      dirty = true; // retry next tick
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
    } finally {
      saving = false;
    }
  }

  /** Read the disk cache once and start the periodic save. */
  function loadOnce() {
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
        cache = parsed.articles ?? {};
      } catch {
        /* first run */
      }
      for (const key of Object.keys(cache)) {
        if (!fresh(cache[key])) {
          delete cache[key];
          dirty = true;
        }
      }
      enforceCap();
      setInterval(() => void save(), 15_000).unref?.();
    })();
    return loading;
  }

  /** One Wikipedia search; `uncertain` when the request itself failed. */
  async function resolveArticle(query) {
    try {
      const res = await fetchImpl(wikipediaSearchUrl(query), {
        headers: { 'User-Agent': WATCHER_USER_AGENT },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) return { article: null, uncertain: true };
      return {
        article: parseWikipediaArticle(await res.json()),
        uncertain: false,
      };
    } catch {
      return { article: null, uncertain: true };
    }
  }

  /**
   * One cached answer per key. A found article or a known miss is stored; an
   * upstream failure is not, and serves the stored answer if there is one.
   * Resolves to { article, failed }.
   */
  function cached(key, query) {
    if (fresh(cache[key]))
      return Promise.resolve({ article: cache[key].data, failed: false });
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          try {
            const { article, uncertain } = await resolveArticle(query);
            if (article || !uncertain) {
              cache[key] = { at: Date.now(), data: article };
              enforceCap();
              dirty = true;
              return { article, failed: false };
            }
            if (cache[key]) return { article: cache[key].data, failed: false };
            return { article: null, failed: true };
          } finally {
            inflight.delete(key);
          }
        })(),
      );
    }
    return inflight.get(key);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/identify', async (req, res) => {
      await loadOnce();
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
        const kind = String(url.searchParams.get('kind') || '');
        if (!KINDS.has(kind)) return send(400, { error: 'invalid kind' });
        const query = parseIdentifyQuery(url.searchParams.get('q') || '');
        if (!query) return send(400, { error: 'invalid query' });
        const { article, failed } = await cached(
          `${kind}|${query.toLowerCase()}`,
          query,
        );
        if (failed) return send(503, { error: 'identify lookup unavailable' });
        return send(200, {
          title: article?.title ?? null,
          summary: article?.summary ?? null,
          image: article?.image ?? null,
          link: article?.link ?? null,
        });
      } catch {
        console.error('[identify] request failed');
        return send(500, { error: 'identify proxy error' });
      }
    });
  };
  return {
    name: 'identify-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
    /** Write pending answers to disk now (the periodic save does the same). */
    flush: save,
  };
}
