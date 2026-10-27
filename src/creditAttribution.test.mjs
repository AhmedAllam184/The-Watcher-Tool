import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readStylesheet(path.join(ROOT, 'style.css'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/*
 * Required-attribution pin.
 *
 * Google Maps Platform and Cesium require the credit line to stay visible
 * whenever their content is on screen. The attribution now lives in the bottom
 * footer (#hud-footer), beside the camera readout, and every bottom-anchored
 * control sits above that footer instead of competing with the credit for the
 * same corner. These checks fail closed on those invariants.
 */

/** Every CSS block whose selector list mentions the given selector text. */
function blocksFor(selectorText) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }))
    .filter((block) => block.selector.includes(selectorText));
}

test('the footer is one fixed bar along the window foot, with its height as the shared token', () => {
  assert.match(css, /:root \{\s*--hud-footer-h: 24px;\s*\}/);
  const footer = blocksFor('#hud-footer').find((block) => /^#hud-footer$/.test(block.selector));
  assert.ok(footer, '#hud-footer rule is missing');
  assert.match(footer.body, /position:\s*fixed;/);
  assert.match(footer.body, /bottom:\s*0;/);
  assert.match(footer.body, /height:\s*var\(--hud-footer-h\);/);
  // Cesium's attribution lightbox is position:fixed. A transform, filter or
  // backdrop on the footer would clip it to the 24px bar.
  assert.doesNotMatch(footer.body, /backdrop-filter|transform|filter:/);
});

test('the footer is in the template and Cesium attaches its credit container to it', () => {
  const template = read('src/ui/templates/scene-chrome.html');
  assert.match(template, /<footer id="hud-footer"/);
  assert.match(template, /id="hud-footer-position"/);
  assert.match(template, /id="hud-footer-credits"/);
  const scene = read('src/app/scene.js');
  assert.match(scene, /getElementById\('hud-footer-credits'\)/);
});

test('the attribution is never hidden, faded or pulled out of the footer', () => {
  const creditBlocks = blocksFor('#cesium-credits');
  assert.ok(creditBlocks.length > 0);
  for (const block of creditBlocks) {
    assert.doesNotMatch(block.body, /display\s*:\s*none/, `${block.selector} hides the credit`);
    assert.doesNotMatch(block.body, /visibility\s*:\s*hidden/, `${block.selector} hides the credit`);
    assert.doesNotMatch(block.body, /opacity\s*:\s*0(\D|$)/, `${block.selector} fades the credit`);
    assert.doesNotMatch(block.body, /position\s*:\s*fixed/, `${block.selector} takes the credit out of the footer`);
  }
});

test('the credit never stacks into the OSM-derived layers row', () => {
  assert.doesNotMatch(css, /body:has\([^)]*alpr-cameras[^}]*#cesium-credits/);
  assert.doesNotMatch(css, /#cesium-credits\s+\.cesium-credit-expand-link\s*\{[^}]*display:\s*block/);
});

test('the Cesium lightbox stays a viewport overlay above the footer', () => {
  const lightbox = blocksFor('.cesium-credit-lightbox-overlay').find((block) => /^\.cesium-credit-lightbox-overlay$/.test(block.selector));
  assert.ok(lightbox, 'the attribution lightbox overlay rule is missing');
  assert.match(lightbox.body, /z-index:\s*200 !important;/);
});

test('bottom-anchored controls clear the footer by its height', () => {
  const offset = /var\(--hud-footer-h\)/;
  const dock = blocksFor('#command-dock').find((block) => /^#command-dock$/.test(block.selector));
  assert.match(dock.body, new RegExp(`bottom:\\s*calc\\(2vh \\+ ${offset.source}\\);`));
  const chip = blocksFor('#key-setup-chip').find((block) => /^#key-setup-chip$/.test(block.selector));
  assert.match(chip.body, new RegExp(`bottom:\\s*calc\\(0\\.9rem \\+ ${offset.source}\\);`));
  const voice = blocksFor('#gev-voice-control').find((block) => /^#gev-voice-control$/.test(block.selector));
  assert.ok(voice, '#gev-voice-control rule is missing');
  assert.doesNotMatch(css, /\.hud-bottom-left|\.hud-bottom-bar/, 'the bottom-left HUD block and its bar are removed');
});

test('the bottom-left quick-layers switcher is gone; its chips live in the VISUAL PRESETS tray', () => {
  assert.doesNotMatch(css, /#quick-layers/);
  const tray = read('src/ui/templates/command-dock.html');
  assert.match(tray, /id="quick-layer-chips"/);
});
