import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFLICT_STYLE,
  clusterEvents,
  clusterPixelSize,
  eventLabel,
  eventPixelSize,
  eventProperties,
  eventStyle,
  severityText,
  summarizeEvents,
  topEvents,
} from './geometry.js';

const EVENTS = [
  {
    id: 'a',
    lat: 35.2,
    lon: 40.1,
    type: 'Battles',
    subType: 'Armed clash',
    fatalities: 3,
    date: '2026-10-26',
    location: 'Deir ez-Zor',
    actors: ['Militia A', 'Militia B'],
    country: 'Syria',
  },
  {
    id: 'b',
    lat: 35.7,
    lon: 40.9,
    type: 'Explosions/Remote violence',
    fatalities: 12,
    date: '2026-10-26',
    location: 'Idlib',
    actors: [],
    country: 'Syria',
  },
  {
    id: 'c',
    lat: 35.1,
    lon: 40.4,
    type: 'News report',
    articles: 4,
    fatalities: null,
    date: '2026-10-27',
    location: 'Aleppo',
    actors: [],
    country: null,
    url: 'https://example.test/a',
  },
  {
    id: 'd',
    lat: -33.9,
    lon: 151.2,
    type: 'Violence against civilians',
    fatalities: 0,
    date: '2026-10-25',
    location: 'Sydney',
    actors: [],
    country: 'Australia',
  },
];

test('each event class maps to its colour, and unknown types read as news reports', () => {
  assert.equal(eventStyle(EVENTS[0]).color, '#ef4444');
  assert.equal(eventStyle(EVENTS[1]).color, '#f97316');
  assert.equal(eventStyle(EVENTS[3]).color, '#a855f7');
  assert.equal(eventStyle(EVENTS[2]).color, '#f59e0b');
  assert.equal(eventStyle({ type: 'Protests' }).color, '#f59e0b');
  assert.deepEqual(Object.keys(CONFLICT_STYLE), [
    'battles',
    'explosions',
    'civilians',
    'news',
  ]);
});

test('sizes grow with severity and stay inside their bounds', () => {
  assert.equal(eventPixelSize({ fatalities: 0 }), 5);
  assert.ok(
    eventPixelSize({ fatalities: 12 }) > eventPixelSize({ fatalities: 1 }),
  );
  assert.equal(eventPixelSize({ fatalities: 100_000 }), 16);
  assert.equal(clusterPixelSize(1), 12);
  assert.equal(clusterPixelSize(1_000_000), 28);
});

test('labels and severity words read naturally for ACLED and GDELT events', () => {
  assert.equal(eventLabel(EVENTS[0]), 'Armed clash · Deir ez-Zor');
  assert.equal(eventLabel(EVENTS[1]), 'Explosions/Remote violence · Idlib');
  assert.equal(severityText(EVENTS[0]), '3 fatalities');
  assert.equal(severityText({ fatalities: 1 }), '1 fatality');
  assert.equal(severityText(EVENTS[2]), '4 articles');
  assert.equal(severityText({ fatalities: null, articles: 1 }), '1 article');
});

test('the most severe events come first', () => {
  assert.deepEqual(
    topEvents(EVENTS, 3).map((event) => event.id),
    ['b', 'c', 'a'],
    'severity is fatalities, or the article count when none is reported',
  );
  assert.equal(topEvents([], 10).length, 0);
});

test('clusters aggregate whole-degree cells with a count and the most severe colour', () => {
  const clusters = clusterEvents(EVENTS);
  assert.equal(
    clusters.length,
    2,
    'Syria events share one cell, Sydney has its own',
  );
  const syria = clusters[0];
  assert.equal(syria.count, 3);
  assert.equal(syria.lat, 35.5);
  assert.equal(syria.lon, 40.5);
  assert.equal(
    syria.styleKey,
    'explosions',
    'the most severe event sets the colour',
  );
  assert.equal(syria.id, 'cluster:1:35:40');
  assert.equal(clusters[1].count, 1);
  assert.equal(clusters[1].styleKey, 'civilians');
});

test('summaries count each class and the total', () => {
  assert.deepEqual(summarizeEvents(EVENTS), {
    total: 4,
    byKey: { battles: 1, explosions: 1, civilians: 1, news: 1 },
  });
});

test('details carry the verification wording, the link and the method', () => {
  const acled = eventProperties(EVENTS[0], {
    source: 'ACLED',
    verified: true,
    method: 'method text',
    note: 'note text',
  });
  assert.equal(acled.verified, 'Yes (ACLED)');
  assert.equal(acled.type, 'Battles · Armed clash');
  assert.equal(acled.fatalities, '3');
  assert.equal(acled.actors, 'Militia A vs Militia B');
  assert.equal(acled.link, undefined);

  const news = eventProperties(EVENTS[2], {
    source: 'GDELT',
    verified: false,
    method: 'm',
    note: 'n',
  });
  assert.equal(news.verified, 'No — news report (GDELT)');
  assert.equal(news.fatalities, 'Not reported');
  assert.equal(news.articles, '4');
  assert.equal(news.country, 'Not reported');
  assert.equal(news.link, 'https://example.test/a');
});
