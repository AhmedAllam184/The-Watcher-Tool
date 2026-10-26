import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LayerPanel,
  fetchKeySetupStatus,
  layerHealth,
  layerHealthSummary,
} from './layerPanel.js';
import { railFixture } from './railTestFixture.mjs';

const FIRMS_URL = 'https://firms.modaps.eosdis.nasa.gov/api/map_key/';
const now = () => Date.now();
const keyStatus = (set) => ({
  keys: [
    { id: 'firms', title: 'NASA FIRMS', set, tier: 'free' },
    { id: 'aisstream', title: 'AISSTREAM', set: true, tier: 'free' },
  ],
  setCount: set ? 2 : 1,
  total: 2,
});
const firmsRow = { id: 'local-firms', requiresKeyId: 'firms', enabled: false };

test('layerHealth maps every feed state to one dot colour', () => {
  const live = { enabled: true, stats: { count: 3, lastUpdate: now() } };
  const cases = [
    ['off', { enabled: false, stats: { count: 3, lastUpdate: now() } }],
    ['off', { enabled: undefined, stats: {} }],
    ['live', live],
    ['working', { ...live, stats: { loading: true } }],
    ['working', { enabled: true, lifecycleState: 'enabling', stats: {} }],
    ['working', { enabled: true, lifecycleState: 'disabling', stats: {} }],
    ['warn', { enabled: true, lifecycleUncertain: true, stats: {} }],
    ['warn', { ...live, stats: { ...live.stats, stale: true } }],
    ['warn', { ...live, stats: { ...live.stats, partial: true } }],
    ['warn', { ...live, stats: { ...live.stats, mode: 'sim' } }],
    ['error', { ...live, stats: { ...live.stats, error: 'Connection lost' } }],
    [
      'error',
      { enabled: true, stats: { count: 0, error: 'feed down' } },
    ],
    ['error', { enabled: true, stats: { status: 'unavailable' } }],
    [
      'error',
      { enabled: false, stats: { sourceUnavailable: true, error: 'x' } },
    ],
  ];
  for (const [expected, layer] of cases)
    assert.equal(layerHealth(layer), expected, JSON.stringify(layer));
});

test('a stale feed that still carries its STALE label is a warning, not a failure', () => {
  assert.equal(
    layerHealth({
      enabled: true,
      stats: { stale: true, error: 'STALE · cached 2h', count: 9, lastUpdate: now() },
    }),
    'warn',
  );
});

test('a missing key outranks feed state and shows before the layer is switched on', () => {
  const missing = keyStatus(false);
  assert.equal(layerHealth(firmsRow, missing), 'key');
  assert.equal(
    layerHealth({ ...firmsRow, enabled: true, stats: { error: 'KEY REQUIRED' } }, missing),
    'key',
  );
  assert.equal(
    layerHealth({ ...firmsRow, enabled: true, stats: { keyRequired: true } }, null),
    'key',
    'stats.keyRequired is enough without a status payload',
  );
  assert.equal(
    layerHealth({ enabled: false, stats: { keyRequired: true } }),
    'key',
  );
});

test('an unknown key status is never read as a missing key', () => {
  assert.equal(layerHealth(firmsRow, null), 'off');
  assert.equal(layerHealth(firmsRow, {}), 'off');
  assert.equal(layerHealth(firmsRow, { keys: 'nope' }), 'off');
  assert.equal(layerHealth(firmsRow, keyStatus(true)), 'off', 'a set key is not a missing one');
  assert.equal(
    layerHealth({ ...firmsRow, requiresKeyId: 'not-a-provider' }, keyStatus(false)),
    'off',
    'an id the status does not list cannot be missing',
  );
  assert.equal(
    layerHealth({ enabled: false, stats: {} }, keyStatus(false)),
    'off',
    'a layer that needs no key is never flagged',
  );
});

test('the summary counts only non-zero parts and says so when nothing is on', () => {
  assert.equal(layerHealthSummary([]), 'All feeds off');
  assert.equal(
    layerHealthSummary([
      { enabled: false, stats: {} },
      { enabled: false, stats: {} },
    ]),
    'All feeds off',
  );
  const live = { enabled: true, stats: { count: 1, lastUpdate: now() } };
  const failing = { enabled: true, stats: { count: 0, error: 'down' } };
  assert.equal(
    layerHealthSummary(
      [live, live, live, { ...firmsRow }, failing],
      keyStatus(false),
    ),
    '3 live · 1 needs a key · 1 failing',
  );
  assert.equal(
    layerHealthSummary([
      { ...firmsRow },
      { ...firmsRow, id: 'other' },
    ], keyStatus(false)),
    '2 need keys',
  );
  assert.equal(
    layerHealthSummary([
      { enabled: true, stats: { loading: true } },
      { enabled: true, stats: { stale: true, count: 2, lastUpdate: now() } },
    ]),
    '1 loading · 1 degraded',
  );
});

test('the summary reads a null key status as unknown, not missing', () => {
  assert.equal(layerHealthSummary([firmsRow], null), 'All feeds off');
});

test('fetchKeySetupStatus returns the payload, or null on any failure', async () => {
  const calls = [];
  const payload = { keys: [], setCount: 0, total: 0 };
  const ok = await fetchKeySetupStatus(async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => payload };
  });
  assert.equal(ok, payload);
  assert.deepEqual(calls, [['/api/setup/status', { cache: 'no-store' }]]);
  assert.equal(
    await fetchKeySetupStatus(async () => ({ ok: false, status: 404 })),
    null,
  );
  assert.equal(
    await fetchKeySetupStatus(async () => {
      throw new TypeError('Failed to fetch');
    }),
    null,
  );
});

test('the key status loads at mount, at most once per 30 seconds, and again on window focus', async () => {
  const f = railFixture();
  const previousDocument = globalThis.document;
  const previousAdd = globalThis.addEventListener;
  const previousRemove = globalThis.removeEventListener;
  const listeners = new Map();
  globalThis.document = f.document;
  globalThis.addEventListener = (type, fn) => listeners.set(type, fn);
  globalThis.removeEventListener = (type) => listeners.delete(type);
  let loads = 0;
  const panel = new LayerPanel({
    getLayers: () => [],
    isEnabled: () => false,
    setEnabled() {},
    setLayerParams() {},
    hasRowControls: () => false,
    subscribeRowControls() {},
    getRowControls: () => null,
    loadKeyStatus: async () => {
      loads += 1;
      return keyStatus(false);
    },
  });
  try {
    panel.mount(f.container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads, 1);
    assert.equal(panel._keyStatus.keys.length, 2);
    listeners.get('focus')();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads, 1, 'focus inside the throttle window is ignored');
    panel._keyStatusRequestedAt -= 30001;
    listeners.get('focus')();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads, 2, 'focus after the window reloads the status');
  } finally {
    panel.destroy();
    assert.equal(listeners.has('focus'), false, 'destroy removes the focus listener');
    globalThis.document = previousDocument;
    globalThis.addEventListener = previousAdd;
    globalThis.removeEventListener = previousRemove;
  }
});

test('a panel without a key-status loader never registers for focus', () => {
  const previousAdd = globalThis.addEventListener;
  let registrations = 0;
  globalThis.addEventListener = () => {
    registrations += 1;
  };
  try {
    new LayerPanel({
      getLayers: () => [],
      isEnabled: () => false,
      setEnabled() {},
      setLayerParams() {},
      hasRowControls: () => false,
      subscribeRowControls() {},
      getRowControls: () => null,
    }).destroy();
  } finally {
    globalThis.addEventListener = previousAdd;
  }
  assert.equal(registrations, 0);
});

/** Minimal element double: textContent drops prior children, like the DOM. */
class FakeMeta {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.nodes = [];
    this._text = '';
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
    this.nodes = this._text ? [this._text] : [];
  }
  append(...nodes) {
    this._text = '';
    this.nodes.push(...nodes);
  }
}

function fakeDocument({ withChip = false } = {}) {
  const stats = { created: 0, clicks: 0 };
  const ids = new Map();
  if (withChip) {
    ids.set('key-setup-chip', {
      isConnected: true,
      click: () => stats.clicks++,
    });
    ids.set('key-setup', {});
  }
  const documentRef = {
    getElementById: (id) => ids.get(id) ?? null,
    createElement: (tag) => {
      stats.created += 1;
      return { tagName: tag.toUpperCase(), className: '', textContent: '' };
    },
  };
  return { documentRef, stats };
}

test('a missing key replaces the meta line with a link to the key, rebuilt only on change', () => {
  const { documentRef, stats } = fakeDocument();
  const meta = new FakeMeta(documentRef);
  const layer = { ...firmsRow, source: 'NASA FIRMS', enabled: false };
  const health = layerHealth(layer, keyStatus(false));
  LayerPanel.prototype._syncMeta(meta, layer, health);
  const [text, link] = meta.nodes;
  assert.equal(text, 'Needs a free NASA FIRMS key — ');
  assert.equal(link.tagName, 'A');
  assert.equal(link.textContent, 'Get key ↗');
  assert.equal(link.href, FIRMS_URL);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(meta.nodes.length, 2, 'no Add key button without the POWER UP panel');

  const created = stats.created;
  LayerPanel.prototype._syncMeta(meta, layer, health);
  assert.equal(stats.created, created, 'an unchanged hint is not rebuilt');
  assert.equal(meta.nodes[1], link, 'the same link node survives a refresh');
});

test('the Add key button appears only when the POWER UP panel is in the page', () => {
  const { documentRef, stats } = fakeDocument({ withChip: true });
  const meta = new FakeMeta(documentRef);
  LayerPanel.prototype._syncMeta(meta, { ...firmsRow, source: 'NASA FIRMS' }, 'key');
  const button = meta.nodes.at(-1);
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.className, 'layer-key-add');
  assert.equal(button.textContent, 'Add key');
  assert.equal(stats.clicks, 0, 'the button opens the dialog only on click');
});

test('a key that is set returns the meta line to its feed text', () => {
  const { documentRef } = fakeDocument();
  const meta = new FakeMeta(documentRef);
  const layer = { ...firmsRow, source: 'NASA FIRMS', enabled: false };
  LayerPanel.prototype._syncMeta(meta, layer, layerHealth(layer, keyStatus(false)));
  const healthy = layerHealth(layer, keyStatus(true));
  LayerPanel.prototype._syncMeta(meta, layer, healthy);
  assert.equal(meta.textContent, 'NASA FIRMS · off');
  assert.equal(meta.nodes.length, 1);
});

test('the meta line says Live with its age when nominal, and off when disabled', () => {
  const panel = LayerPanel.prototype;
  assert.match(
    panel._buildMetaText({
      enabled: true,
      source: 'OpenSky',
      stats: { count: 4, lastUpdate: now() - 5000 },
    }),
    /^Live · OpenSky · updated \d+s ago$/,
  );
  assert.equal(
    panel._buildMetaText({
      enabled: false,
      source: 'OpenSky',
      stats: { count: 4, lastUpdate: now() },
    }),
    'OpenSky · off',
  );
  assert.equal(
    panel._buildMetaText({ enabled: false, source: 'OpenSky', stats: {} }),
    'OpenSky · off',
  );
});
