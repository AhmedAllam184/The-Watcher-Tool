import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion, createMilitaryFeed } from './ingestion.js';
function setup(source) {
  const feed = createMilitaryFeed(source);
  const accepted = [];
  const labels = [];
  const restores = [];
  const { methods } = createIngestion({
    feed,
    applySnapshot: (snapshot) => {
      accepted.push(snapshot);
      return { count: 1, ids: new Set(['aaa001']) };
    },
    setSourceLabel: (label) => labels.push(label),
    applyPendingTrackingRestore: () => restores.push(true),
  });
  return { feed, accepted, labels, restores, update: methods.update };
}

test('military acquisition cancels late replies without publishing or restoring tracking', async () => {
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

test('military acquisition keeps the degraded source reason and respects retry admission', async () => {
  let calls = 0;
  const probe = setup({
    async getSnapshot() {
      calls++;
      return {
        records: [],
        source: 'Fixture',
        observedAtMs: 1234,
        freshness: 'stale',
        stale: true,
        reason: 'Upstream refreshing',
      };
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._lastUpdate, 1234);
  assert.equal(probe.feed._lastError, 'Upstream refreshing');
  assert.equal(probe.feed._backoff, true);
  assert.deepEqual(probe.labels, ['Fixture']);
  probe.feed._retryAt = Date.now() + 60000;
  await probe.update(null);
  assert.equal(calls, 1);
  assert.equal(probe.restores.length, 1);
  assert.equal(
    probe.feed._lastTrackingRefreshOutcome.status,
    'source-unavailable',
  );
});

test('military acquisition announces a new emergency squawk once per contact and code', async () => {
  const announced = [];
  const records = [
    {
      id: 'aaa001',
      callsign: 'RCH401',
      squawk: '7500',
      latitude: 1,
      longitude: 2,
    },
  ];
  const feed = createMilitaryFeed({
    label: 'Fixture',
    getSnapshot: async () => ({
      records,
      source: 'Fixture',
      observedAtMs: Date.now(),
      ageMs: 0,
      stale: false,
      freshness: 'current',
      complete: true,
    }),
  });
  const { methods } = createIngestion({
    feed,
    applySnapshot: () => ({ count: 1, ids: new Set(['aaa001']) }),
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
    onSquawkAlerts: (alerts) => announced.push(...alerts),
  });
  await methods.update(null);
  await methods.update(null);
  assert.deepEqual(
    announced.map((alert) => alert.code),
    ['7500'],
  );
});
