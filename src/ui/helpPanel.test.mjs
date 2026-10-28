import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHelpPanel, HELP_SHORTCUTS } from './helpPanel.js';
import { bindApplicationShortcuts } from './applicationShortcuts.js';
import {
  applyStoredTextSize,
  applyTextSize,
  LARGE_TEXT_CLASS,
  LARGE_TEXT_STORAGE_KEY,
  readLargeTextPreference,
} from './textSize.js';

function makeElement(tag, ownerDocument) {
  const listeners = {};
  const classes = new Set();
  const element = {
    tagName: tag.toUpperCase(),
    ownerDocument,
    id: '',
    className: '',
    hidden: false,
    disabled: false,
    type: '',
    checked: false,
    style: {},
    attributes: {},
    children: [],
    parent: null,
    listeners,
    text: '',
    classList: {
      toggle(name, force) {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    get textContent() {
      return element.text;
    },
    set textContent(value) {
      element.text = String(value);
      element.children = [];
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
      (listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((h) => h !== handler);
    },
    dispatch(type, event = {}) {
      for (const handler of [...(listeners[type] || [])]) handler(event);
    },
    click(event = {}) {
      element.dispatch('click', {
        target: element,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    },
    focus() {
      ownerDocument.activeElement = element;
    },
  };
  return element;
}

function makeDocument() {
  const listeners = {};
  const doc = {
    activeElement: null,
    createElement: (tag) => makeElement(tag, doc),
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((h) => h !== handler);
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    },
    press(key, { target = null, shiftKey = false } = {}) {
      const event = {
        key,
        shiftKey,
        target,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
      };
      for (const handler of [...(listeners.keydown || [])]) handler(event);
      return event;
    },
  };
  doc.body = makeElement('body', doc);
  doc.documentElement = makeElement('html', doc);
  return doc;
}

function makeStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function stubGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (candidate) => {
    if (predicate(candidate)) found.push(candidate);
  });
  return found;
}

function byClass(node, className) {
  return findAll(node, (el) => el.className === className);
}

function headingsOf(panel) {
  return findAll(panel, (el) => el.tagName === 'H3').map((el) => el.text);
}

function setup(t, options = {}) {
  const doc = makeDocument();
  const storage = options.storage ?? makeStorage();
  stubGlobal(t, 'document', doc);
  stubGlobal(t, 'localStorage', storage);
  const trigger = doc.createElement('button');
  doc.activeElement = trigger;
  const help = createHelpPanel({
    root: doc.body,
    openKeySetup: options.openKeySetup ?? null,
    canOpenKeySetup: options.canOpenKeySetup ?? null,
    openQuickStart: options.openQuickStart ?? null,
    toggleButton: options.toggleButton ?? null,
  });
  const panel = doc.body.children.find((child) => child.id === 'help-panel');
  const closeButton = byClass(panel, 'help-panel__close')[0];
  const largeText = byClass(panel, 'help-panel__check')[0];
  const keyButton = byClass(panel, 'help-panel__action')[0] ?? null;
  return {
    doc,
    storage,
    trigger,
    help,
    panel,
    closeButton,
    largeText,
    keyButton,
  };
}

test('the dialog starts hidden with the modal attributes and five sections', (t) => {
  const { panel, help } = setup(t);
  assert.equal(panel.hidden, true);
  assert.equal(panel.attributes.role, 'dialog');
  assert.equal(panel.attributes['aria-modal'], 'true');
  assert.equal(panel.attributes['aria-labelledby'], 'help-panel-title');
  assert.equal(panel.className, 'help-panel');
  assert.deepEqual(headingsOf(panel), [
    'Getting around',
    'Keyboard shortcuts',
    'Map legend',
    'Feed status dots',
    'Settings',
  ]);
  assert.equal(help.isOpen(), false);
});

test('the legend swatches come from the modules that draw the map', (t) => {
  const { panel } = setup(t);
  const swatches = byClass(panel, 'help-panel__swatch').map(
    (el) => el.style.background,
  );
  assert.deepEqual(swatches, [
    '#ffffff', // aircraft, commercial (flights/rendering.js)
    '#ffb800', // aircraft, military (flights/policy.js MIL_TINT)
    'rgb(57, 213, 255)', // cargo (vesselLabels accentForVesselType)
    'rgb(255, 179, 71)', // tanker
    'rgb(255, 122, 223)', // passenger
    'rgb(124, 255, 155)', // fishing
    'rgb(57, 213, 255)', // other, the fallback style
    'rgb(240, 178, 62)', // active fire, orange stop (firmsLabels)
    '#ff0000', // earthquake, shallow (earthquakes/model.js)
    '#4fd8ff', // satellite, navigation (satelliteClass.js)
    '#f87171', // satellite, military (satelliteClass.js SATELLITE_CLASSES.military)
    '#fbbf24', // GPS interference, medium (layers/gpsJam/geometry.js GPS_JAM_STYLE)
    '#f87171', // GPS interference, high (layers/gpsJam/geometry.js GPS_JAM_STYLE)
    '#ef4444', // conflict, battles (data/conflictLabels.js CONFLICT_STYLE)
    '#f97316', // conflict, explosions or remote violence (CONFLICT_STYLE)
    '#a855f7', // conflict, violence against civilians (CONFLICT_STYLE)
    '#f59e0b', // conflict, news report (CONFLICT_STYLE)
  ]);
});

test('the airport disrupted and watch rings are in the legend with their colours', (t) => {
  const { panel } = setup(t);
  const ringFor = (label) => {
    const row = findAll(
      panel,
      (el) =>
        el.className === 'help-panel__swatch-row' &&
        el.children.some((child) => child.text === label),
    )[0];
    assert.ok(row, `${label} renders`);
    return row.children.find((child) => child.className.includes('--ring'))
      .style.borderColor;
  };
  assert.equal(ringFor('Airport disrupted (inferred)'), '#f87171');
  assert.equal(ringFor('Airport watch (inferred)'), '#fbbf24');
});

test('the feed dots reuse the shared feed-dot class and health values', (t) => {
  const { panel } = setup(t);
  const dots = byClass(panel, 'feed-dot');
  assert.deepEqual(
    dots.map((dot) => dot.attributes['data-health']),
    ['live', 'working', 'warn', 'error', 'key', 'off'],
  );
});

test('open focuses the close button and close returns focus to the previous element', (t) => {
  const { help, panel, closeButton, trigger, doc } = setup(t);
  help.open();
  assert.equal(help.isOpen(), true);
  assert.equal(panel.hidden, false);
  assert.equal(doc.activeElement, closeButton);
  help.close();
  assert.equal(help.isOpen(), false);
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, trigger);
});

test('Escape closes an open dialog and is ignored while closed', (t) => {
  const { help, doc } = setup(t);
  doc.press('Escape');
  assert.equal(help.isOpen(), false);
  help.open();
  const event = doc.press('Escape');
  assert.equal(help.isOpen(), false);
  assert.equal(event.stopped, true);
});

test('a click on the backdrop closes the dialog but a click inside the card does not', (t) => {
  const { help, panel } = setup(t);
  help.open();
  const inside = byClass(panel, 'help-panel__card')[0];
  panel.click({ target: inside });
  assert.equal(help.isOpen(), true);
  panel.click({ target: panel });
  assert.equal(help.isOpen(), false);
});

test('Tab is trapped inside the dialog in both directions', (t) => {
  const { help, doc, closeButton, largeText } = setup(t);
  help.open();
  // Shift+Tab from the first control wraps to the last.
  let event = doc.press('Tab', { shiftKey: true, target: closeButton });
  assert.equal(event.defaultPrevented, true);
  assert.equal(doc.activeElement, largeText);
  // Tab from the last control wraps to the first.
  event = doc.press('Tab', { target: largeText });
  assert.equal(doc.activeElement, closeButton);
  // Focus that escaped to the page comes back in.
  doc.activeElement = doc.createElement('button');
  doc.press('Tab');
  assert.equal(doc.activeElement, closeButton);
  // Native tab order handles the middle of the list.
  const middle = doc.press('Tab', { target: closeButton });
  assert.equal(middle.defaultPrevented, false);
});

test('the toolbar button toggles the dialog and reports aria-expanded', (t) => {
  const toolbarButton = makeElement('button', null);
  const { help, panel } = setup(t, { toggleButton: toolbarButton });
  assert.equal(toolbarButton.attributes['aria-expanded'], 'false');
  assert.equal(toolbarButton.attributes['aria-controls'], 'help-panel');
  toolbarButton.click();
  assert.equal(help.isOpen(), true);
  assert.equal(toolbarButton.attributes['aria-expanded'], 'true');
  toolbarButton.click();
  assert.equal(help.isOpen(), false);
  assert.equal(panel.hidden, true);
  assert.equal(toolbarButton.attributes['aria-expanded'], 'false');
});

test('larger text applies the class and persists the choice', (t) => {
  const { help, largeText, storage, doc } = setup(t);
  help.open();
  assert.equal(largeText.checked, false);
  largeText.checked = true;
  largeText.dispatch('change', {});
  assert.equal(doc.documentElement.classList.contains(LARGE_TEXT_CLASS), true);
  assert.equal(storage.values.get(LARGE_TEXT_STORAGE_KEY), '1');
  largeText.checked = false;
  largeText.dispatch('change', {});
  assert.equal(doc.documentElement.classList.contains(LARGE_TEXT_CLASS), false);
  assert.equal(storage.values.get(LARGE_TEXT_STORAGE_KEY), '0');
});

test('a saved larger-text choice is shown when the dialog opens and applied at startup', (t) => {
  const storage = makeStorage();
  storage.setItem(LARGE_TEXT_STORAGE_KEY, '1');
  const { help, largeText, doc } = setup(t, { storage });
  assert.equal(doc.documentElement.classList.contains(LARGE_TEXT_CLASS), false);
  help.open();
  assert.equal(largeText.checked, true);

  const restored = makeStorage();
  restored.setItem(LARGE_TEXT_STORAGE_KEY, '1');
  const root = makeElement('html', null);
  assert.equal(applyStoredTextSize({ root, storage: restored }), true);
  assert.equal(root.classList.contains(LARGE_TEXT_CLASS), true);
  assert.equal(restored.values.get(LARGE_TEXT_STORAGE_KEY), '1');
});

test('blocked or throwing storage still applies the class for the page view', () => {
  const blocked = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const root = makeElement('html', null);
  assert.equal(readLargeTextPreference({ storage: blocked }), false);
  assert.equal(applyTextSize(true, { root, storage: blocked }), true);
  assert.equal(root.classList.contains(LARGE_TEXT_CLASS), true);
  assert.equal(applyTextSize(false, { root, storage: null }), false);
  assert.equal(root.classList.contains(LARGE_TEXT_CLASS), false);
});

test('the POWER UP button appears only when key setup is reachable and hands off to it', (t) => {
  let reachable = false;
  let opened = 0;
  const { help, keyButton, panel } = setup(t, {
    openKeySetup: () => {
      opened += 1;
    },
    canOpenKeySetup: () => reachable,
  });
  assert.equal(keyButton.textContent, 'Add API keys (POWER UP)');
  help.open();
  assert.equal(keyButton.hidden, true);
  help.close();
  reachable = true;
  help.open();
  assert.equal(keyButton.hidden, false);
  keyButton.click();
  assert.equal(help.isOpen(), false);
  assert.equal(opened, 1);
  assert.equal(panel.hidden, true);
});

test('without openKeySetup there is no POWER UP button', (t) => {
  const { keyButton } = setup(t);
  assert.equal(keyButton, null);
});

test('Quick-start missions… sits in Settings after POWER UP, closes the dialog and reopens the card', (t) => {
  let opened = 0;
  const { help, panel, keyButton } = setup(t, {
    openKeySetup: () => {},
    openQuickStart: () => {
      opened += 1;
    },
  });
  const quickStart = findAll(panel, (el) => el.text === 'Quick-start missions…');
  assert.equal(quickStart.length, 1, 'the Settings section offers the missions');
  assert.equal(quickStart[0].className, 'help-panel__action');
  // POWER UP stays the first action button, so existing lookups keep finding it.
  assert.equal(keyButton.textContent, 'Add API keys (POWER UP)');
  help.open();
  quickStart[0].click();
  assert.equal(help.isOpen(), false);
  assert.equal(panel.hidden, true);
  assert.equal(opened, 1);
});

test('without openQuickStart there is no Quick-start button', (t) => {
  const { panel } = setup(t);
  assert.equal(findAll(panel, (el) => el.text === 'Quick-start missions…').length, 0);
});

test('destroy removes the dialog, its listeners and the toolbar wiring', (t) => {
  const toolbarButton = makeElement('button', null);
  const { help, panel, doc, storage } = setup(t, { toggleButton: toolbarButton });
  help.open();
  help.destroy();
  help.destroy();
  assert.equal(panel.parent, null);
  assert.equal(doc.listenerCount('keydown'), 0);
  assert.equal(help.isOpen(), false);
  help.open();
  assert.equal(help.isOpen(), false);
  toolbarButton.click();
  assert.equal(help.isOpen(), false);
  assert.equal(storage.values.size, 0);
});

test('the shortcut list mirrors the bindings in applicationShortcuts.js', () => {
  const source = readFileSync(
    new URL('./applicationShortcuts.js', import.meta.url),
    'utf8',
  );
  for (const letter of ['h', 'o', 'v', 'f', 'd', 'c']) {
    assert.match(source, new RegExp(`key === '${letter}'`));
  }
  for (const digit of ['1', '2', '3', '4', '5', '6', '7']) {
    assert.match(source, new RegExp(`\\s${digit}: '[a-z]+'`));
  }
  assert.match(source, /event\.key === '\/'/);
  assert.match(source, /event\.key === '\?'/);
  assert.match(source, /event\.key === 'Escape'/);
  const listed = HELP_SHORTCUTS.flatMap((shortcut) => shortcut.keys);
  assert.deepEqual(
    listed.sort(),
    ['/', '1–7', '?', 'C', 'D', 'Esc', 'F', 'H', 'O', 'V'].sort(),
  );
});

function shortcutHarness({ openDialogs = [] } = {}) {
  const listeners = [];
  const documentRef = {
    addEventListener: (type, handler) => listeners.push([type, handler]),
    removeEventListener: () => {},
    querySelector: () => openDialogs[0] ?? null,
    querySelectorAll: () => openDialogs,
  };
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get: (_target, name) => () => calls.push(name),
    },
  );
  bindApplicationShortcuts({
    documentRef,
    searchInput: {},
    actions,
  });
  const press = (key) => {
    const event = {
      key,
      target: { matches: () => false, isContentEditable: false },
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const [type, handler] of listeners) if (type === 'keydown') handler(event);
    return event;
  };
  return { calls, press };
}

test('? toggles the help panel, and the / search key never fires for it', () => {
  const plain = shortcutHarness();
  plain.press('?');
  assert.deepEqual(plain.calls, ['toggleHelp']);
  plain.press('/');
  assert.deepEqual(plain.calls, ['toggleHelp', 'openSearch']);

  const withHelpOpen = shortcutHarness({ openDialogs: [{ id: 'help-panel' }] });
  withHelpOpen.press('?');
  assert.deepEqual(withHelpOpen.calls, ['toggleHelp']);
  withHelpOpen.press('/');
  assert.deepEqual(withHelpOpen.calls, ['toggleHelp']);

  const otherDialog = shortcutHarness({ openDialogs: [{ id: 'first-run-launcher' }] });
  otherDialog.press('?');
  assert.deepEqual(otherDialog.calls, []);
});
