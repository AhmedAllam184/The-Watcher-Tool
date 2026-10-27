import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictBboxParam,
  createConflictSource,
  normalizeConflictSnapshot,
} from './conflict.js';

const PAYLOAD = {
  generatedAt: 1_780_000_000_000,
  source: 'acled',
  verified: true,
  days: 7,
  note: 'Verified armed-conflict events from ACLED.',
  method: 'ACLED events of type Battles.',
  fetchedAt: 1_779_999_000_000,
  events: [
    {
      id: 'acled:SYR1234',
      lat: 35.3,
      lon: 40.1,
      date: '2026-10-26',
      type: 'Battles',
      subType: 'Armed clash',
      fatalities: 7,
      actors: ['Militia A', ''],
      country: 'Syria',
      location: 'Deir ez-Zor',
      title: 'Armed clash · Deir ez-Zor',
      url: 'https://example.test/story',
      sourceName: 'Example Wire',
    },
    { id: 'bad-lat', lat: 'north', lon: 1, type: 'Battles' },
    {
      id: 'bad-url',
      lat: 1,
      lon: 2,
      type: 'News report',
      url: 'javascript:alert(1)',
    },
    { id: '', lat: 1, lon: 2, type: 'Battles' },
  ],
};

test('a valid payload normalizes to the snapshot shape, dropping unusable events', () => {
  const snapshot = normalizeConflictSnapshot(PAYLOAD, 7);
  assert.equal(snapshot.source, 'acled');
  assert.equal(snapshot.verified, true);
  assert.equal(snapshot.days, 7);
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events[0], {
    id: 'acled:SYR1234',
    lat: 35.3,
    lon: 40.1,
    date: '2026-10-26',
    type: 'Battles',
    subType: 'Armed clash',
    fatalities: 7,
    articles: null,
    actors: ['Militia A'],
    country: 'Syria',
    location: 'Deir ez-Zor',
    title: 'Armed clash · Deir ez-Zor',
    url: 'https://example.test/story',
    sourceName: 'Example Wire',
  });
  assert.equal(snapshot.events[1].url, undefined, 'only http(s) links survive');
});

test('anything other than ACLED is presented as the unverified GDELT source', () => {
  const snapshot = normalizeConflictSnapshot(
    { ...PAYLOAD, source: 'gdelt', verified: true, days: 99 },
    1,
  );
  assert.equal(snapshot.source, 'gdelt');
  assert.equal(
    snapshot.verified,
    false,
    'a payload cannot claim verification for GDELT',
  );
  assert.equal(
    snapshot.days,
    1,
    'an unsupported window falls back to the request',
  );
});

test('a malformed top-level shape is rejected', () => {
  for (const payload of [null, 'text', {}, { events: 'nope' }]) {
    assert.throws(
      () => normalizeConflictSnapshot(payload, 1),
      /Malformed conflict events snapshot/,
    );
  }
});

test('bounding boxes serialize only when every edge is finite and ordered', () => {
  assert.equal(
    conflictBboxParam({ west: 10, south: 20, east: 30, north: 40 }),
    '10,20,30,40',
  );
  assert.equal(conflictBboxParam(null), null);
  assert.equal(
    conflictBboxParam({ west: 30, south: 20, east: 10, north: 40 }),
    null,
  );
  assert.equal(
    conflictBboxParam({ west: 10, south: 20, east: 30, north: NaN }),
    null,
  );
  assert.equal(
    conflictBboxParam({ west: -190, south: 0, east: 0, north: 1 }),
    null,
  );
});

test('getSnapshot requests the window and bounding box from the same-origin route', async () => {
  const calls = [];
  const source = createConflictSource({
    fetchImpl: async (href, init) => {
      calls.push({ href, init });
      return new Response(JSON.stringify(PAYLOAD), { status: 200 });
    },
  });
  const snapshot = await source.getSnapshot({
    days: 7,
    bbox: { west: 10, south: 20, east: 30, north: 40 },
  });
  assert.equal(calls[0].href, '/api/conflicts?days=7&bbox=10%2C20%2C30%2C40');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(snapshot.events.length, 2);
});

test('getSnapshot defaults to the 24 h window and rejects unsupported windows before fetching', async () => {
  const calls = [];
  const source = createConflictSource({
    fetchImpl: async (href) => {
      calls.push(href);
      return new Response(JSON.stringify(PAYLOAD), { status: 200 });
    },
  });
  await source.getSnapshot();
  assert.equal(calls[0], '/api/conflicts?days=1');
  await assert.rejects(source.getSnapshot({ days: 3 }), RangeError);
  assert.equal(calls.length, 1);
});

test('HTTP failures surface the status, and aborts propagate', async () => {
  const failing = createConflictSource({
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  await assert.rejects(failing.getSnapshot(), /Conflict events HTTP 503/);

  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const aborted = createConflictSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(
    aborted.getSnapshot({ signal: controller.signal }),
    /stop/,
  );
});
