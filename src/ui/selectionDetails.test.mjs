import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionDetailsPanel } from './selectionDetails.js';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

function makeElement(tagName, ownerDocument) {
  const element = {
    tagName: tagName.toUpperCase(),
    ownerDocument,
    id: '',
    className: '',
    hidden: false,
    disabled: false,
    href: '',
    target: '',
    rel: '',
    type: '',
    children: [],
    parent: null,
    attributes: {},
    listeners: {},
    text: '',
    get textContent() {
      return this.text;
    },
    set textContent(value) {
      this.text = String(value);
      if (this.text === '') this.children = [];
    },
    append(...nodes) {
      for (const node of nodes) element.appendChild(node);
    },
    appendChild(child) {
      child.parent = element;
      element.children.push(child);
      return child;
    },
    remove() {
      if (!element.parent) return;
      element.parent.children = element.parent.children.filter(
        (child) => child !== element,
      );
      element.parent = null;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return element.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      (element.listeners[type] ||= []).push(handler);
    },
    click() {
      for (const handler of element.listeners.click || []) handler({});
    },
    keydown(key) {
      const event = { key, stopped: false, stopPropagation() { this.stopped = true; } };
      for (const handler of element.listeners.keydown || []) handler(event);
      return event;
    },
  };
  return element;
}

function makeEnvironment() {
  const documentStub = { hidden: false };
  const documentListeners = new Set();
  documentStub.addEventListener = (type, handler) => {
    if (type === 'visibilitychange') documentListeners.add(handler);
  };
  documentStub.removeEventListener = (type, handler) => {
    documentListeners.delete(handler);
  };
  documentStub.dispatchVisibility = (hidden) => {
    documentStub.hidden = hidden;
    for (const handler of [...documentListeners]) handler();
  };
  documentStub.documentListenerCount = () => documentListeners.size;
  documentStub.createElement = (tag) => makeElement(tag, documentStub);
  const body = makeElement('body', documentStub);
  const windowListeners = {};
  const intervals = new Map();
  let nextInterval = 1;
  const frames = [];
  const windowStub = {
    document: documentStub,
    addEventListener(type, handler) {
      (windowListeners[type] ||= new Set()).add(handler);
    },
    removeEventListener(type, handler) {
      windowListeners[type]?.delete(handler);
    },
    dispatch(type, detail) {
      for (const handler of [...(windowListeners[type] || [])])
        handler({ type, detail });
    },
    listenerCount() {
      return Object.values(windowListeners).reduce(
        (total, set) => total + set.size,
        0,
      );
    },
    setInterval(fn, ms) {
      const id = nextInterval++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    flushFrames() {
      while (frames.length) frames.shift()();
    },
    tick() {
      for (const { fn } of [...intervals.values()]) fn();
    },
    intervalCount() {
      return intervals.size;
    },
  };
  documentStub.defaultView = windowStub;
  documentStub.body = body;
  return { documentStub, body, windowStub };
}

function findAll(element, predicate, found = []) {
  if (predicate(element)) found.push(element);
  for (const child of element.children) findAll(child, predicate, found);
  return found;
}

function findByClass(element, className) {
  return findAll(element, (node) => node.className.split(' ').includes(className))[0];
}

function flightRecord(overrides = {}) {
  return {
    id: 'abc123',
    layerId: 'flights',
    layerName: 'Live Flights',
    source: 'OpenSky',
    label: 'BAW117',
    latitude: 51.5,
    longitude: -0.25,
    properties: {
      operator: 'British Airways',
      callsign: 'BAW117',
      icao24: 'abc123',
      altitude: '35,000 ft',
      speed: '450 kt',
      heading: '270°',
      status: 'live',
    },
    ...overrides,
  };
}

function setup(options = {}) {
  const env = makeEnvironment();
  let selected = null;
  const flown = [];
  const copied = [];
  const panel = createSelectionDetailsPanel({
    root: env.body,
    flyTo: (lat, lon) => flown.push([lat, lon]),
    copyText: async (text) => {
      copied.push(text);
    },
    getSelected: () => selected,
    now: () => NOW,
    ...options,
  });
  return {
    ...env,
    panel,
    flown,
    copied,
    setSelected(record) {
      selected = record;
    },
    aside: env.body.children[0],
  };
}

test('selecting an object shows one panel with the plain-language rows', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);

  const { aside } = env;
  assert.equal(aside.id, 'selection-details');
  assert.equal(aside.hidden, false);
  assert.equal(aside.attributes['aria-label'], 'Selected object details');
  assert.equal(findByClass(aside, 'selection-details__kind').textContent, 'Flight');
  assert.equal(findByClass(aside, 'selection-details__title').textContent, 'BAW117');
  const terms = findAll(aside, (node) => node.tagName === 'DT').map((n) => n.textContent);
  const values = findAll(aside, (node) => node.tagName === 'DD').map((n) => n.textContent);
  assert.ok(terms.includes('Altitude'));
  assert.equal(values[terms.indexOf('Altitude')], '35,000 ft (10,668 m)');
  const links = findAll(aside, (node) => node.tagName === 'A');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
});

test('visible panel refreshes once a second and stops when hidden', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  assert.equal(env.windowStub.intervalCount(), 1);

  env.setSelected(flightRecord({ properties: { ...record.properties, speed: '500 kt' } }));
  env.windowStub.tick();
  const terms = findAll(env.aside, (node) => node.tagName === 'DT').map((n) => n.textContent);
  const values = findAll(env.aside, (node) => node.tagName === 'DD').map((n) => n.textContent);
  assert.equal(values[terms.indexOf('Speed')], '500 kt (926 km/h)');

  env.panel.hide();
  assert.equal(env.aside.hidden, true);
  assert.equal(env.windowStub.intervalCount(), 0);
});

test('a deliberate clear hides the panel; an eviction keeps values with a note', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);

  env.setSelected(null);
  env.windowStub.dispatch('gev:entity-selection-cleared', {
    layerId: 'flights',
    reason: 'evicted',
  });
  assert.equal(env.aside.hidden, false);
  const notice = findByClass(env.aside, 'selection-details__notice');
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, 'No longer updating');
  assert.equal(findByClass(env.aside, 'selection-details__title').textContent, 'BAW117');
  assert.equal(env.windowStub.intervalCount(), 0);

  env.windowStub.dispatch('gev:entity-selection-cleared', {
    layerId: 'flights',
    reason: 'deliberate',
  });
  assert.equal(env.aside.hidden, true);
});

test('clearing another layer leaves the panel alone', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  env.windowStub.dispatch('gev:entity-selection-cleared', {
    layerId: 'ais-live-vessels',
    reason: 'deliberate',
  });
  assert.equal(env.aside.hidden, false);
});

test('close button and Escape only hide the panel and Escape does not bubble', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);

  const close = findByClass(env.aside, 'selection-details__close');
  close.click();
  assert.equal(env.aside.hidden, true);

  env.windowStub.dispatch('gev:entity-selected', record);
  const event = env.aside.keydown('Escape');
  assert.equal(env.aside.hidden, true);
  assert.equal(event.stopped, true);

  env.windowStub.dispatch('gev:entity-selected', record);
  const other = env.aside.keydown('a');
  assert.equal(env.aside.hidden, false);
  assert.equal(other.stopped, false);
});

test('awareness subjects resolve on the next frame, or fall back to a minimal panel', () => {
  const env = setup();
  const record = flightRecord({ id: 'def456', label: 'RYR9' });
  env.setSelected(record);
  env.windowStub.dispatch('gev:awareness-subject-selected', {
    layerId: 'flights',
    id: 'def456',
    label: 'RYR9',
  });
  assert.equal(env.aside.hidden, true, 'waits for the subject to register');
  env.windowStub.flushFrames();
  assert.equal(env.aside.hidden, false);
  assert.equal(findByClass(env.aside, 'selection-details__title').textContent, 'BAW117');

  env.setSelected(null);
  env.windowStub.dispatch('gev:awareness-subject-selected', {
    layerId: 'military-flights',
    id: 'zzz999',
    label: 'NATO01',
  });
  env.windowStub.flushFrames();
  assert.equal(findByClass(env.aside, 'selection-details__title').textContent, 'NATO01');
  assert.equal(findByClass(env.aside, 'selection-details__notice').hidden, true);
  assert.equal(env.windowStub.intervalCount(), 0);

  env.windowStub.dispatch('gev:awareness-subject-cleared', { layerId: 'military-flights' });
  assert.equal(env.aside.hidden, true);
});

test('Fly to and Copy coordinates use the record position', async () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);

  const [flyButton, copyButton] = findAll(
    env.aside,
    (node) => node.tagName === 'BUTTON' && node.className.includes('__action'),
  );
  flyButton.click();
  assert.deepEqual(env.flown, [[51.5, -0.25]]);

  copyButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.copied, ['51.5000, -0.2500']);
  assert.equal(findByClass(env.aside, 'selection-details__feedback').textContent, 'Coordinates copied');
});

test('Fly to is disabled without a camera action or coordinates', () => {
  const env = setup({ flyTo: null });
  const record = flightRecord({ latitude: Number.NaN });
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  const [flyButton, copyButton] = findAll(
    env.aside,
    (node) => node.tagName === 'BUTTON' && node.className.includes('__action'),
  );
  assert.equal(flyButton.disabled, true);
  assert.equal(copyButton.disabled, true);
});

test('destroy removes the element, listeners and timer', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  assert.equal(env.windowStub.listenerCount(), 4);

  env.panel.destroy();
  assert.equal(env.windowStub.listenerCount(), 0);
  assert.equal(env.windowStub.intervalCount(), 0);
  assert.equal(env.body.children.length, 0);
  env.panel.destroy();
});

/** Photo loader stub that records lookups and resolves to `photo`. */
function photoStub(photo = null) {
  const calls = [];
  return {
    calls,
    load(hex) {
      calls.push(hex);
      return Promise.resolve(typeof photo === 'function' ? photo(hex) : photo);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const PHOTO = {
  src: 'https://t.plnspttrs.net/1/large.jpg',
  link: 'https://www.planespotters.net/photo/1/example',
  photographer: 'Jane Spotter',
  source: 'Planespotters.net',
};

test('a flight shows its aircraft photo with credit and a source link', async () => {
  const photoLoader = photoStub(PHOTO);
  const env = setup({ photoLoader });
  const record = flightRecord({ id: 'abc123' });
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);

  const figure = findByClass(env.aside, 'selection-details__photo');
  assert.equal(figure.hidden, false);
  assert.equal(findByClass(figure, 'selection-details__photo-status').textContent, 'Loading aircraft photo…');
  await flush();
  assert.deepEqual(photoLoader.calls, ['abc123']);
  assert.equal(figure.hidden, false);
  const anchor = findAll(figure, (node) => node.tagName === 'A')[0];
  assert.equal(anchor.href, PHOTO.link);
  assert.equal(anchor.target, '_blank');
  assert.equal(anchor.rel, 'noopener noreferrer');
  const image = findAll(figure, (node) => node.tagName === 'IMG')[0];
  assert.equal(image.attributes.src, PHOTO.src);
  assert.equal(image.attributes.alt, 'Photo of BAW117');
  assert.equal(image.attributes.loading, 'lazy');
  assert.equal(image.attributes.referrerpolicy, 'no-referrer');
  assert.equal(
    findByClass(figure, 'selection-details__photo-credit').textContent,
    '© Jane Spotter · Planespotters.net',
  );
  assert.equal(findAll(figure, (node) => node.className === 'selection-details__photo-status').length, 0);
});

test('the photo is not reloaded by the one-second refresh, only when the hex changes', async () => {
  const photoLoader = photoStub(PHOTO);
  const env = setup({ photoLoader });
  const record = flightRecord({ id: 'abc123' });
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  await flush();
  env.windowStub.tick();
  env.windowStub.tick();
  await flush();
  assert.deepEqual(photoLoader.calls, ['abc123']);

  const other = flightRecord({ id: 'def456', label: 'UAL1', properties: { icao24: 'def456', callsign: 'UAL1', operator: 'United' } });
  env.setSelected(other);
  env.windowStub.dispatch('gev:entity-selected', other);
  await flush();
  assert.deepEqual(photoLoader.calls, ['abc123', 'def456']);
});

test('no photo leaves the figure hidden and a non-flight never looks one up', async () => {
  const photoLoader = photoStub(null);
  const env = setup({ photoLoader });
  const record = flightRecord({ id: 'abc123' });
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  await flush();
  const figure = findByClass(env.aside, 'selection-details__photo');
  assert.equal(figure.hidden, true);
  assert.equal(figure.children.length, 0);

  const fire = { id: 'firms-1', layerId: 'firms-fires', label: 'Fire', latitude: 1, longitude: 2, properties: {} };
  env.setSelected(fire);
  env.windowStub.dispatch('gev:entity-selected', fire);
  await flush();
  assert.deepEqual(photoLoader.calls, ['abc123']);
});

test('clearing the selection drops the photo and a late answer is ignored', async () => {
  let resolveLate;
  const photoLoader = {
    calls: [],
    load(hex) {
      this.calls.push(hex);
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    },
  };
  const env = setup({ photoLoader });
  const record = flightRecord({ id: 'abc123' });
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  await flush();
  const figure = findByClass(env.aside, 'selection-details__photo');
  assert.equal(figure.hidden, false);
  env.windowStub.dispatch('gev:entity-selection-cleared', { layerId: 'flights', reason: 'deliberate' });
  assert.equal(env.aside.hidden, true);
  resolveLate(PHOTO);
  await flush();
  assert.equal(figure.hidden, true);
  assert.equal(figure.children.length, 0);
});

test('a broken photo image removes the block without touching the rest of the panel', async () => {
  const env = setup({ photoLoader: photoStub(PHOTO) });
  const record = flightRecord({ id: 'abc123' });
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  await flush();
  const image = findAll(env.aside, (node) => node.tagName === 'IMG')[0];
  image.listeners.error.forEach((handler) => handler({}));
  const figure = findByClass(env.aside, 'selection-details__photo');
  assert.equal(figure.hidden, true);
  assert.equal(findByClass(env.aside, 'selection-details__title').textContent, 'BAW117');
});

test('a hidden tab stops the live refresh and returning to it refreshes at once', () => {
  const env = setup();
  const record = flightRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  assert.equal(env.windowStub.intervalCount(), 1);

  env.documentStub.dispatchVisibility(true);
  assert.equal(env.windowStub.intervalCount(), 0, 'background tab does not poll');

  env.setSelected(flightRecord({ properties: { ...record.properties, speed: '600 kt' } }));
  env.documentStub.dispatchVisibility(false);
  assert.equal(env.windowStub.intervalCount(), 1, 'timer resumes on return');
  const values = findAll(env.aside, (node) => node.tagName === 'DD').map((n) => n.textContent);
  assert.ok(values.some((value) => value.startsWith('600 kt')), 'refreshed on return');

  env.panel.destroy();
  assert.equal(env.documentStub.documentListenerCount(), 0);
});

/** Label → value text of the rows the panel currently shows. */
function rowTexts(aside) {
  const list = findByClass(aside, 'selection-details__rows');
  const texts = {};
  for (let i = 0; i < list.children.length; i += 2) {
    texts[list.children[i].textContent] = list.children[i + 1].textContent;
  }
  return texts;
}

function satelliteRecord(overrides = {}) {
  return {
    id: '25544',
    layerId: 'satellites',
    layerName: 'Satellites',
    source: 'CelesTrak',
    label: 'ISS (ZARYA)',
    latitude: 51.6,
    longitude: -0.1,
    properties: { name: 'ISS (ZARYA)', noradId: '25544', class: 'STATION · ISS', altitude: '420 km' },
    ...overrides,
  };
}

function satelliteLoader(answer) {
  const calls = [];
  return {
    calls,
    load(norad) {
      calls.push(norad);
      return typeof answer === 'function' ? answer(norad) : Promise.resolve(answer);
    },
  };
}

const SATELLITE_ANSWER = {
  satellite: {
    norad: 25544,
    name: 'ISS (ZARYA)',
    owner: { code: 'ISS', name: 'International Space Station partners' },
    objectTypeText: 'Payload (working spacecraft)',
    statusText: 'Operational',
    launchDate: '1998-11-20',
    launchSite: { code: 'TYMSC', name: 'Baikonur, Kazakhstan' },
    intlDesignator: '1998-067A',
    orbitClass: 'LEO',
    apogeeKm: 420,
    perigeeKm: 413,
    inclinationDeg: 51.6,
    periodMin: 92.9,
  },
};

test('a selected satellite loads its catalogue record once and shows it when it arrives', async () => {
  const loader = satelliteLoader(SATELLITE_ANSWER);
  const env = setup({ satelliteInfoLoader: loader });
  const record = satelliteRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  assert.equal(env.aside.className.includes('selection-details--satellite'), true);
  assert.equal(findByClass(env.aside, 'selection-details__kind').textContent, 'Satellite');
  assert.equal(rowTexts(env.aside).Catalogue, 'Loading catalogue data…');
  await flush();
  env.windowStub.tick();
  env.windowStub.tick();
  await flush();
  assert.deepEqual(loader.calls, ['25544'], 'the one-second refresh does not refetch');
  const rows = rowTexts(env.aside);
  assert.equal(rows.Catalogue, undefined);
  assert.equal(rows['Owner / country'], 'International Space Station partners');
  assert.equal(rows.Orbit, 'LEO · 420 km × 413 km · 51.6° · 93 min');
  assert.equal(rows.Altitude, '420 km');
});

test('a satellite whose lookup fails says so, and a rocket body is named before any answer', async () => {
  const env = setup({ satelliteInfoLoader: satelliteLoader(() => Promise.reject(new Error('down'))) });
  const record = satelliteRecord();
  env.setSelected(record);
  env.windowStub.dispatch('gev:entity-selected', record);
  await flush();
  assert.equal(rowTexts(env.aside).Catalogue, 'Info unavailable');

  const body = satelliteRecord({ id: '28228', label: 'CZ-2C R/B', properties: { name: 'CZ-2C R/B', noradId: '28228' } });
  env.setSelected(body);
  env.windowStub.dispatch('gev:entity-selected', body);
  await flush();
  assert.equal(
    rowTexts(env.aside).Type,
    'Rocket body — spent upper stage, not a working satellite',
  );
});

test('a late catalogue answer for a previous satellite is ignored', async () => {
  const releases = [];
  const loader = satelliteLoader(() => new Promise((resolve) => { releases.push(resolve); }));
  const env = setup({ satelliteInfoLoader: loader });
  const first = satelliteRecord();
  env.setSelected(first);
  env.windowStub.dispatch('gev:entity-selected', first);
  const second = satelliteRecord({ id: '28228', label: 'SAMPLE', properties: { name: 'SAMPLE', noradId: '28228' } });
  env.setSelected(second);
  env.windowStub.dispatch('gev:entity-selected', second);
  await flush();
  releases[0]({ satellite: SATELLITE_ANSWER.satellite });
  await flush();
  assert.deepEqual(loader.calls, ['25544', '28228']);
  assert.equal(rowTexts(env.aside)['Owner / country'], undefined, 'the first answer does not land on the second satellite');
});
