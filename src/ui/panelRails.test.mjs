import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { displayPanelScroller } from './displayPanelScroll.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  layoutLeftPanelRail,
  layoutRightPanelRail,
  measurePanelNaturalHeight,
} from './panelRails.js';

test('Display uses an inner scroll body only in Cyber', () => {
  const body = { scrollTop: 95 };
  const panel = {
    ownerDocument: { documentElement: { dataset: { uiTheme: 'cyber' } } },
    querySelector: () => body,
  };
  assert.equal(displayPanelScroller(panel), body);
  panel.ownerDocument.documentElement.dataset.uiTheme = 'tactical';
  assert.equal(displayPanelScroller(panel), panel);
  assert.equal(displayPanelScroller(null), null);
});

test('Cyber restores one expanded owner, keeps launchers, and restores other theme preferences', () => {
  for (const mobile of [false, true]) {
    const f = fixture('right', {
      mobile,
      hud: { visible: true, variant: 'cyber' },
    });
    f.expand(f.first, 250);
    f.expand(f.second, 250);
    f.options.preferredPanelId = f.second.id;
    f.run();
    assert.equal(f.first.classList.contains('cyber-accordion-collapsed'), true);
    assert.equal(f.second.classList.contains('collapsed'), false);
    assert.equal(f.first.getAttribute('aria-hidden'), undefined);
    f.run();
    assert.equal(
      f.first.classList.contains('collapsed'),
      true,
      'layout does not reopen a peer',
    );
    f.options.hud.variant = 'operator';
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(
      f.first.classList.contains('cyber-accordion-collapsed'),
      false,
    );
    assert.equal(f.second.classList.contains('collapsed'), false);
  }
});

test('Cyber restored accordion prefers keyboard focus when no explicit owner exists', () => {
  const f = fixture('right', { hud: { visible: true, variant: 'cyber' } });
  f.expand(f.first, 250);
  f.expand(f.second, 250);
  f.options.documentRef.activeElement = f.second;
  f.run();
  assert.equal(f.first.classList.contains('collapsed'), true);
  assert.equal(f.second.classList.contains('collapsed'), false);
});

function element(
  id,
  { height = 42, top = 234, left = 20, width = 272, collapsed = false } = {},
) {
  const classes = new Set(collapsed ? ['collapsed'] : []);
  const properties = new Map();
  const attributes = new Map();
  const writes = [];
  const node = {
    id,
    children: [],
    dataset: {},
    parentElement: null,
    scrollHeight: height,
    clientHeight: height,
    scrollTop: 0,
    computed: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      rowGap: '12px',
      getPropertyValue: () => '',
    },
    rect: {
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
    },
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, value) {
        if (value) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) {
        writes.push(['set', name, value]);
        properties.set(name, value);
      },
      getPropertyValue: (name) => properties.get(name) || '',
      removeProperty(name) {
        writes.push(['remove', name]);
        properties.delete(name);
      },
    },
    getBoundingClientRect() {
      return this.rect;
    },
    matches: (selector) =>
      selector === '[data-panel-id]' ||
      (selector === '[data-panel-id]:not(.panel-floating)' &&
        !classes.has('panel-floating')),
    contains(target) {
      return (
        target === this || this.children.some((child) => child.contains(target))
      );
    },
    querySelectorAll() {
      return this.children;
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name),
    hasAttribute: (name) => attributes.has(name),
    writes,
  };
  return node;
}
function fixture(
  side,
  { mobile = false, hud = { visible: true, variant: 'tactical' } } = {},
) {
  const first = element('first', { height: 42, collapsed: true });
  const second = element('second', { height: 42, collapsed: true });
  const stack = element('rail', {
    height: 96,
    left: side === 'left' ? 20 : 1100,
  });
  stack.children = [first, second];
  first.parentElement = second.parentElement = stack;
  const documentRef = { activeElement: null };
  stack.ownerDocument = documentRef;
  const collapsed = [];
  let retries = 0;
  const options = {
    stack,
    hud,
    documentRef,
    obstacles: [],
    collapsedHeights: new Map(),
    windowRef: {
      innerHeight: 900,
      matchMedia: () => ({ matches: mobile }),
      getComputedStyle: (node) => node.computed,
    },
    onCollapse: (panel) => collapsed.push(panel.id),
    onRetry: () => {
      retries += 1;
    },
    displayPanel: null,
    readDisplayScrollTop: () => 0,
    leftStack: element('left'),
  };
  const run = () =>
    (side === 'left' ? layoutLeftPanelRail : layoutRightPanelRail)(options);
  const expand = (panel, height) => {
    panel.classList.remove('collapsed');
    panel.scrollHeight = height;
    panel.rect.height = height;
    panel.rect.bottom = panel.rect.top + height;
  };
  return {
    options,
    first,
    second,
    stack,
    run,
    expand,
    collapsed,
    retries: () => retries,
  };
}

test('missing rails are inert without browser globals', () => {
  layoutLeftPanelRail({});
  layoutRightPanelRail({});
});

test('left layout records collapsed heights without changing disclosure', () => {
  const f = fixture('left');
  f.run();
  assert.equal(f.options.collapsedHeights.get('first'), 42);
  assert.equal(f.first.classList.contains('collapsed'), true);
  assert.equal(f.retries(), 0);
  assert.equal(f.stack.dataset.layoutMode, 'normal');
});

test('left lane starts under the app title when the HUD mission card is not rendered', () => {
  const f = fixture('left');
  const title = element('title', { top: 0, height: 40 });
  f.options.obstacles = [title];
  f.run();
  assert.ok(Number(f.stack.dataset.safeTopPct) < 10);
});

test('left lane clears the live title block by 12px, read from its rectangle', () => {
  // The title is read from the document, so a pass that skips it as an
  // obstacle still cannot place the lane over the brand.
  const f = fixture('left');
  const title = element('title', { top: 16, height: 90, left: 16, width: 330 });
  f.stack.ownerDocument.getElementById = (id) =>
    id === 'title-bar' ? title : null;
  f.options.obstacles = [];
  f.run();
  // Title bottom is 106px; 106 + 12 = 118px of a 900px viewport.
  assert.ok(
    Number(f.stack.dataset.safeTopPct) >= (118 / 900) * 100 - 0.01,
    `lane starts at ${f.stack.dataset.safeTopPct}%, above the title clearance`,
  );
});

test('left lane ignores a title block that is hidden at layout time', () => {
  const f = fixture('left');
  const title = element('title', { top: 16, height: 90, left: 16, width: 330 });
  title.computed.display = 'none';
  f.stack.ownerDocument.getElementById = (id) =>
    id === 'title-bar' ? title : null;
  f.options.obstacles = [];
  f.run();
  assert.ok(Number(f.stack.dataset.safeTopPct) < 5);
});

test('left lane keeps its 26% floor while the HUD mission card is rendered', () => {
  const f = fixture('left');
  const title = element('title', { top: 0, height: 40 });
  const card = element('card', { top: 120, height: 80 });
  card.matches = (selector) => selector === '#intel-hud .hud-top-left';
  f.options.obstacles = [title, card];
  f.run();
  assert.equal(f.stack.dataset.safeTopPct, '26.00');
});

test('left corridor respects a lower obstacle but ignores an obstacle hidden by its parent', () => {
  const f = fixture('left');
  const blocker = element('blocker', { top: 600, height: 80 });
  const hidden = element('hidden', { top: 300, height: 80 });
  hidden.parentElement = element('hidden-parent');
  hidden.parentElement.computed.opacity = '0';
  f.options.obstacles = [blocker, hidden];
  f.run();
  assert.equal(Number(f.stack.dataset.safeBottomPct), 65.47);
});

for (const side of ['left']) {
  test(`${side} mobile layout releases desktop height/position styles and labels`, () => {
    const f = fixture(side, { mobile: true });
    f.stack.classList.add('layout-focus');
    f.stack.style.setProperty(`--${side}-stack-safe-top`, '300px');
    f.first.style.setProperty(`--${side}-panel-allocated-height`, '99px');
    f.first.setAttribute('aria-hidden', 'true');
    f.run();
    assert.equal(f.stack.dataset.layoutMode, 'mobile');
    assert.equal(
      f.stack.style.getPropertyValue(`--${side}-stack-safe-top`),
      '',
    );
    assert.equal(
      f.first.style.getPropertyValue(`--${side}-panel-allocated-height`),
      '',
    );
    assert.equal(f.first.getAttribute('aria-hidden'), undefined);
  });
  test(`${side} constrained layout preserves the preferred panel and requests another pass`, () => {
    const f = fixture(side);
    f.expand(f.first, 900);
    f.expand(f.second, 900);
    f.options.preferredPanelId = 'second';
    f.run();
    assert.equal(f.second.classList.contains('collapsed'), false);
    assert.equal(f.first.classList.contains('layout-auto-collapsed'), true);
    assert.deepEqual(f.collapsed, ['first']);
    assert.equal(f.retries(), 1);
  });
  test(`${side} hidden HUD restores automatic collapse without altering manual collapse`, () => {
    const f = fixture(side, { hud: { visible: false, variant: 'tactical' } });
    f.first.classList.add('layout-auto-collapsed');
    f.run();
    assert.equal(f.first.classList.contains('collapsed'), false);
    assert.equal(f.second.classList.contains('collapsed'), true);
    assert.deepEqual(f.collapsed, ['first']);
  });
}

test('natural height includes visible content, margins and wrapper chrome, excluding hidden rows', () => {
  const panel = element('panel');
  const inner = element('inner', { top: 100 });
  inner.computed.paddingTop = '10px';
  inner.computed.paddingBottom = '5px';
  const row = element('row', { top: 110, height: 40 });
  row.scrollHeight = 80;
  row.computed.marginBottom = '3px';
  const hidden = element('hidden', { top: 1000, height: 900 });
  hidden.computed.visibility = 'hidden';
  panel.computed.borderTopWidth = '1px';
  panel.computed.borderBottomWidth = '1px';
  panel.children = [inner];
  inner.children = [row, hidden];
  assert.equal(
    measurePanelNaturalHeight(panel, (node) => node.computed),
    100,
  );
});

// Reproduce the allocation-dependent readings seen beside the weather card.
// Outside measurement, CCTV is 391 px in focus and 629 px in normal mode;
// Removing only the allocation leaves focus CSS active: its next reading is
// 422 px, so the old decision exits focus and then re-enters on the 629 px read.
function thrashingRightRail({ focused = false, weatherOpen = false } = {}) {
  const f = fixture('right');
  f.options.windowRef.innerHeight = 920;
  f.options.leftStack.rect.top = 439.6;
  f.stack.computed.rowGap = '8px';
  const display = element('pp-toggles', { collapsed: true });
  const cctv = element('cctv-panel', { height: 629 });
  const weather = element('weather-panel', {
    height: 444,
    collapsed: !weatherOpen,
  });
  const context = element('global-context-panel', { collapsed: true });
  if (!weatherOpen) weather.classList.add('layout-auto-collapsed');
  f.stack.children = [display, cctv, weather, context];
  f.stack.classList.toggle('layout-focus', focused);
  f.options.preferredPanelId = cctv.id;
  f.options.displayPanel = display;
  const allocation = '--right-panel-allocated-height';
  const measuring = () =>
    f.stack.getAttribute('data-rail-measuring') !== undefined;
  for (const panel of f.stack.children) {
    panel.parentElement = f.stack;
    panel.intrinsicHeight = panel.rect.height;
    panel.style.setProperty(allocation, '391px');
    panel.getBoundingClientRect = () => {
      let height;
      if (panel.classList.contains('collapsed')) {
        height =
          measuring() || f.stack.classList.contains('layout-focus') ? 44 : 0;
      } else if (measuring()) {
        height = panel.intrinsicHeight;
      } else if (f.stack.classList.contains('layout-focus')) {
        height = 391;
      } else {
        height = panel.intrinsicHeight;
      }
      return { ...panel.rect, height, bottom: panel.rect.top + height };
    };
    Object.defineProperty(panel, 'scrollHeight', {
      get: () => {
        if (measuring())
          return panel.classList.contains('collapsed')
            ? 44
            : panel.intrinsicHeight;
        if (panel.classList.contains('collapsed'))
          return panel.getBoundingClientRect().height;
        return f.stack.classList.contains('layout-focus') &&
          panel.style.getPropertyValue(allocation)
          ? 603
          : 422;
      },
    });
  }
  return { ...f, cctv, weather };
}

/** Strip comments and return the bodies of every ≤720px media block. */
function narrowScreenBlocks(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('@media (max-width: 720px) {', from);
    if (start === -1) break;
    const open = source.indexOf('{', start);
    let depth = 0;
    let close = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}' && (depth -= 1) === 0) {
        close = index;
        break;
      }
    }
    assert.notEqual(close, -1, 'unterminated narrow-screen media block');
    blocks.push(source.slice(open + 1, close));
    from = close + 1;
  }
  assert.ok(blocks.length, 'narrow-screen media block is missing');
  return blocks;
}

/** Split a flat (non-nested) rule list into [selectors, declarations] pairs. */
function flatRules(block) {
  assert.doesNotMatch(block, /@media/, 'nested media queries are not modelled');
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selectors, declarations]) => [
      selectors.split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
      declarations,
    ],
  );
}

test('narrow-screen rails pin every hosted panel glow inside its panel box', () => {
  const css = readStylesheet(new URL('../../style.css', import.meta.url));
  for (const panel of [
    'data-panel',
    'scene-panel',
    'cctv-panel',
    'global-context-panel',
  ]) {
    assert.match(
      css,
      new RegExp(`#${panel} \\.panel-glow \\{[^}]*\\binset: -\\d+px;`),
      `${panel} glow no longer overhangs its panel; revisit this pin`,
    );
  }
  const narrow = narrowScreenBlocks(css).flatMap(flatRules);
  const scrollingRails = [
    ...new Set(
      narrow
        .filter(([, declarations]) =>
          /\boverflow(?:-y)?:\s*(?:auto|scroll)\b/.test(declarations),
        )
        .flatMap(([selectors]) => selectors)
        .filter((selector) =>
          /^#(?:left-panel-stack|right-context-rail)$/.test(selector),
        ),
    ),
  ].sort();
  assert.deepEqual(scrollingRails, [
    '#left-panel-stack',
    '#right-context-rail',
  ]);
  for (const rail of scrollingRails) {
    assert.ok(
      narrow.some(
        ([selectors, declarations]) =>
          selectors.includes(`${rail} .panel-glow`) &&
          /(?:^|;)\s*inset:\s*0\s*;/.test(declarations),
      ),
      `${rail} scrolls at ≤720px but does not pin its panel glows (inset: 0)`,
    );
  }
});

test('a collapsed TOOLS card keeps its header row when the column is focused', () => {
  const f = fixture('left');
  // The second card is the TOOLS card: it scrolls its own body.
  f.second.setAttribute('data-scroll-card', '');
  f.expand(f.first, 900);
  f.run();
  assert.equal(f.stack.classList.contains('layout-focus'), true);
  assert.equal(f.second.classList.contains('collapsed'), true);
  assert.equal(f.second.getAttribute('aria-hidden'), undefined);
  const allocated = parseFloat(
    f.first.style.getPropertyValue('--left-panel-allocated-height'),
  );
  assert.ok(
    allocated > 0 && allocated < 900,
    'the open card gives up the header row',
  );
  assert.equal(f.collapsed.length, 0);
});

test('an open TOOLS card auto-collapses no other card and shares the column with them', () => {
  const f = fixture('left');
  f.second.setAttribute('data-scroll-card', '');
  f.expand(f.first, 900);
  f.expand(f.second, 900);
  f.options.preferredPanelId = 'second';
  f.run();
  assert.equal(f.first.classList.contains('layout-auto-collapsed'), false);
  assert.equal(f.second.classList.contains('collapsed'), false);
  assert.deepEqual(f.collapsed, []);
  assert.equal(f.retries(), 0);
  const shares = [f.first, f.second].map((panel) =>
    parseFloat(panel.style.getPropertyValue('--left-panel-allocated-height')),
  );
  assert.ok(
    shares.every((height) => height > 0),
    'both cards keep a share',
  );
  assert.ok(shares[0] + shares[1] <= 900, 'the two shares fit the column');
});

test('a column that pins its own edges is budgeted against its rendered box', () => {
  const pinned = fixture('left');
  pinned.stack.computed.getPropertyValue = (name) =>
    name === '--left-stack-pinned' ? '1' : '';
  pinned.stack.rect = {
    top: 220,
    left: 20,
    width: 300,
    height: 430,
    right: 320,
    bottom: 650,
  };
  pinned.expand(pinned.first, 900);
  pinned.run();
  const pinnedShare = parseFloat(
    pinned.first.style.getPropertyValue('--left-panel-allocated-height'),
  );
  assert.ok(
    pinnedShare <= 430,
    `pinned share ${pinnedShare} exceeds the 430px box`,
  );

  // Unpinned, the engine owns the edges and the lane is the viewport lane.
  const free = fixture('left');
  free.expand(free.first, 900);
  free.run();
  assert.ok(
    parseFloat(
      free.first.style.getPropertyValue('--left-panel-allocated-height'),
    ) > 430,
    'an unpinned column keeps the engine lane',
  );
});

test('a TOOLS card measures its whole scroll height, borders included', () => {
  const card = element('right-context-rail', { height: 300 });
  card.setAttribute('data-scroll-card', '');
  card.scrollHeight = 540;
  card.computed.borderTopWidth = '1px';
  card.computed.borderBottomWidth = '1px';
  assert.equal(
    measurePanelNaturalHeight(card, (node) => node.computed),
    542,
  );
});

test('the TOOLS engine places nothing: the card owns its position and scroll body', () => {
  const f = fixture('right');
  f.expand(f.first, 900);
  f.run();
  assert.equal(f.stack.dataset.layoutMode, 'column');
  assert.equal(f.stack.style.getPropertyValue('--right-stack-safe-top'), '');
  assert.equal(
    f.first.style.getPropertyValue('--right-panel-allocated-height'),
    '',
  );
  assert.equal(f.stack.classList.contains('layout-focus'), false);
  assert.deepEqual(f.collapsed, [], 'no automatic collapse of sub-panels');
  assert.equal(f.retries(), 0);
});
