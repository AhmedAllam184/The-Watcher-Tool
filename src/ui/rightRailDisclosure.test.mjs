import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelChrome } from './panelChrome.js';

const THEMES = ['tactical', 'operator', 'minimal', 'cyber'];

/** Right rail with DISPLAY, CONTEXT (holding RADIO) and CCTV; all start collapsed. */
function fixture(theme = 'tactical') {
  const nodes = new Map();
  const node = (id, collapsed = true) => {
    const classes = new Set(collapsed ? ['collapsed'] : []);
    const value = {
      id,
      hidden: false,
      children: [],
      matches: () => true,
      contains(target) {
        return this === target || this.children.some((child) => child.contains(target));
      },
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
    };
    nodes.set(id, value);
    return value;
  };
  const rail = node('rail');
  const display = node('pp-toggles');
  const context = node('global-context-panel');
  const cctv = node('cctv-panel');
  const radio = node('radio-panel');
  rail.children = [display, context, cctv];
  for (const panel of rail.children) panel.parentElement = rail;
  context.children = [radio];
  radio.parentElement = context;
  const saved = [];
  const owner = {
    _rightPanelStack: rail,
    _panelLayout: {},
    _lifetime: { frame() {} },
    _syncPanelCollapseButton() {},
    _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {},
    _layoutRightPanels() {},
    _syncCctvPanelViewport() {},
    _savePanelCollapsedState: (...args) => saved.push(args),
    shareLinkManager: { claimRestoreLane() {}, onPanelStateChange() {} },
  };
  owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed.bind(owner);
  return {
    display,
    context,
    cctv,
    radio,
    owner,
    saved,
    doc: {
      documentElement: { dataset: { uiTheme: theme } },
      getElementById: (id) => nodes.get(id),
    },
  };
}

/** Run `body` with the fixture's document in scope, restoring the global afterwards. */
function withDocument(f, body) {
  const prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    body();
  } finally {
    globalThis.document = prior;
  }
}

test('a user expanding a right-rail panel closes its expanded peers in every theme', () => {
  for (const theme of THEMES) {
    const f = fixture(theme);
    withDocument(f, () => {
      f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
      f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
      assert.equal(f.cctv.classList.contains('collapsed'), false, theme);
      assert.equal(f.display.classList.contains('collapsed'), true, `${theme}: DISPLAY closes`);
      // The closed peer is a user preference, so it stays closed on reload.
      assert.ok(
        f.saved.some(([id, collapsed]) => id === 'pp-toggles' && collapsed === true),
        `${theme}: peer collapse is saved`,
      );
    });
  }
});

test('expanding a rail panel that is already open closes nothing', () => {
  const f = fixture();
  withDocument(f, () => {
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    assert.equal(f.cctv.classList.contains('collapsed'), false);
    assert.deepEqual(f.saved, [['cctv-panel', false]]);
  });
});

test('collapsing a rail panel never opens or closes a peer', () => {
  const f = fixture();
  withDocument(f, () => {
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('cctv-panel', true, { explicit: true });
    assert.equal(f.display.classList.contains('collapsed'), true);
    assert.equal(f.cctv.classList.contains('collapsed'), true);
  });
});

test('a floating window is outside the accordion in both directions', () => {
  const f = fixture();
  withDocument(f, () => {
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    f.cctv.classList.add('panel-floating');
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    assert.equal(f.cctv.classList.contains('collapsed'), false, 'floating window opens');
    assert.equal(f.display.classList.contains('collapsed'), false, 'docked DISPLAY stays open');

    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.cctv.classList.contains('collapsed'), false, 'floating window is not closed');
  });
});

test('restores and automatic layout never run the accordion', () => {
  const f = fixture();
  withDocument(f, () => {
    f.owner.setPanelCollapsed('pp-toggles', false, { restore: true, persist: false });
    f.owner.setPanelCollapsed('cctv-panel', false, { restore: true, persist: false });
    assert.equal(f.display.classList.contains('collapsed'), false);
    assert.equal(f.cctv.classList.contains('collapsed'), false);
    // Automatic (non-explicit) opening, as the CCTV feed does on its own.
    f.owner.setPanelCollapsed('cctv-panel', true, { persist: false });
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: false });
    assert.equal(f.display.classList.contains('collapsed'), false);
  });
});

test('a panel outside the rail, such as RADIO, is not an accordion owner', () => {
  const f = fixture();
  withDocument(f, () => {
    f.owner.setPanelCollapsed('pp-toggles', false, { restore: true, persist: false });
    f.owner.setPanelCollapsed('global-context-panel', false, { restore: true, persist: false });
    // Radio is nested in CONTEXT, so opening it leaves DISPLAY alone.
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    assert.equal(f.radio.classList.contains('collapsed'), false);
    assert.equal(f.display.classList.contains('collapsed'), false);
  });
});

test('a user opening RADIO reveals CONTEXT as a user choice and closes DISPLAY', () => {
  for (const theme of THEMES) {
    const f = fixture(theme);
    withDocument(f, () => {
      f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
      f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
      assert.equal(f.context.classList.contains('collapsed'), false, theme);
      assert.equal(f.radio.classList.contains('collapsed'), false, theme);
      assert.equal(f.display.classList.contains('collapsed'), true, `${theme}: DISPLAY closes`);
    });
  }
});
