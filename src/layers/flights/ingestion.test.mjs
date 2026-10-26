import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlightFeed, createIngestion } from './ingestion.js';

function setup(source) {
  const feed = {
    _source: source,
    _activeUpdateControllers: new Set(),
    _trackingRefreshEpoch: 0,
    _lastSource: 'Fixture',
    _lastCoverage: 'local',
    _retryAt: 0,
  };
  const accepted = [];
  const labels = [];
  const restores = [];
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({ latitude: 39 }),
    applySnapshot: (snapshot) => {
      accepted.push(snapshot);
      return { count: 2, ids: new Set(['abc123']) };
    },
    setSourceLabel: (label) => labels.push(label),
    applyPendingTrackingRestore: () => restores.push(true),
  });
  return { feed, accepted, labels, restores, update: methods.update };
}

test('civil acquisition rejects late completion after cancellation without publishing records', async () => {
  let release;
  const probe = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const request = probe.update(null);
  assert.equal(probe.feed._activeUpdateControllers.size, 1);
  for (const controller of probe.feed._activeUpdateControllers)
    controller.abort();
  release({ records: [] });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(probe.accepted.length, 0);
  assert.equal(probe.restores.length, 0);
  assert.equal(probe.feed._activeUpdateControllers.size, 0);
});

test('civil acquisition publishes source time and uses a replaced source on the next request', async () => {
  let calls = 0;
  const probe = setup({
    async getSnapshot(query) {
      assert.equal(query.latitude, 39);
      calls += 1;
      return {
        records: [],
        source: 'First',
        observedAtMs: 1234,
        freshness: 'fresh',
        coverage: 'worldwide',
      };
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._lastUpdate, 1234);
  assert.equal(probe.feed._count, 2);
  assert.deepEqual([...probe.feed._lastTrackingRefreshOutcome.ids], ['abc123']);
  probe.feed._source = {
    async getSnapshot() {
      return {
        records: [],
        source: 'Second',
        observedAtMs: 1250,
        freshness: 'unknown',
      };
    },
  };
  await probe.update(null);
  assert.equal(calls, 1);
  assert.equal(probe.feed._lastUpdate, 1250);
  assert.equal(probe.feed._backoff, true);
  assert.equal(probe.feed._lastError, 'Source snapshot time unavailable');
  assert.deepEqual(probe.labels, ['First', 'Second']);
  assert.equal(probe.restores.length, 2);
});

test('civil acquisition announces a new emergency squawk once per contact and code', async () => {
  const announced = [];
  let records = [
    {
      id: 'abc123',
      callsign: 'UAL123',
      squawk: '7700',
      latitude: 1,
      longitude: 2,
    },
  ];
  const feed = createFlightFeed({
    label: 'Fixture',
    getSnapshot: async () => ({
      records,
      source: 'Fixture',
      coverage: 'local',
      observedAtMs: Date.now(),
      ageMs: 0,
      stale: false,
      freshness: 'current',
      complete: true,
    }),
  });
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({}),
    applySnapshot: () => ({ count: 1, ids: new Set(['abc123']) }),
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
    onSquawkAlerts: (alerts) => announced.push(...alerts),
  });
  await methods.update(null);
  await methods.update(null);
  assert.deepEqual(
    announced.map((alert) => alert.code),
    ['7700'],
  );
  records = [{ id: 'abc123', callsign: 'UAL123', squawk: '7600' }];
  await methods.update(null);
  assert.deepEqual(
    announced.map((alert) => alert.code),
    ['7700', '7600'],
  );
});
