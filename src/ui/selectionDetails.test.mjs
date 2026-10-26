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
  const documentStub = {};
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
