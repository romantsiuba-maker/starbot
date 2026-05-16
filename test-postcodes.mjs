#!/usr/bin/env node
// Unit tests for lib/postcodes.js (PR 50: lead-to-map loop).
//
// Pure offline coverage of the input normalisers + the tiered fetch
// dispatcher. Live API tests live in test-postcodes-live.mjs (not run in CI).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geocodePostcode,
  geocodeColumns,
  normalisePostcode,
  __test__,
} from './lib/postcodes.js';

const { normaliseOutcode, isLikelyAreaName, PLACE_ADDRESS_TYPES } = __test__;

// ── normalisePostcode ────────────────────────────────────────────────

test('normalisePostcode: strips spaces, uppercases', () => {
  assert.equal(normalisePostcode('sw1a 1aa'), 'SW1A1AA');
  assert.equal(normalisePostcode('  EC2A 4DP  '), 'EC2A4DP');
  assert.equal(normalisePostcode('M11AE'), 'M11AE');
});

test('normalisePostcode: rejects non-postcodes', () => {
  assert.equal(normalisePostcode(''), null);
  assert.equal(normalisePostcode(null), null);
  assert.equal(normalisePostcode('Canary Wharf'), null);
  assert.equal(normalisePostcode('x'), null);
  assert.equal(normalisePostcode('1234'), null);   // 4 chars
  assert.equal(normalisePostcode('012345678901'), null); // 12 chars
});

// ── normaliseOutcode ─────────────────────────────────────────────────

test('normaliseOutcode: accepts UK outward codes', () => {
  assert.equal(normaliseOutcode('EC2A'), 'EC2A');
  assert.equal(normaliseOutcode('sw1a'), 'SW1A');
  assert.equal(normaliseOutcode(' M1 '), 'M1');
  assert.equal(normaliseOutcode('B1'), 'B1');
  assert.equal(normaliseOutcode('SW1'), 'SW1');
});

test('normaliseOutcode: rejects full postcodes + garbage', () => {
  assert.equal(normaliseOutcode('SW1A1AA'), null); // too long, tier 1's job
  assert.equal(normaliseOutcode('M'), null);        // single letter
  assert.equal(normaliseOutcode('1A'), null);       // starts with digit
  assert.equal(normaliseOutcode('Canary Wharf'), null);
  assert.equal(normaliseOutcode(''), null);
  assert.equal(normaliseOutcode(null), null);
});

// ── isLikelyAreaName ────────────────────────────────────────────────

test('isLikelyAreaName: accepts plausible place names', () => {
  assert.equal(isLikelyAreaName('Canary Wharf'), true);
  assert.equal(isLikelyAreaName('Manchester'), true);
  assert.equal(isLikelyAreaName('North London'), true);
  assert.equal(isLikelyAreaName('Mayfair'), true);
});

test('isLikelyAreaName: rejects garbage', () => {
  assert.equal(isLikelyAreaName(''), false);
  assert.equal(isLikelyAreaName('x'), false);
  assert.equal(isLikelyAreaName('12'), false);
  assert.equal(isLikelyAreaName('###'), false);
  assert.equal(isLikelyAreaName(null), false);
});

// ── geocodeColumns ───────────────────────────────────────────────────

test('geocodeColumns: success with postcode (tiers 1-2)', () => {
  const cols = geocodeColumns({
    status: 'success',
    postcode: 'SW1A 1AA',
    lat: 51.5,
    lng: -0.14,
    geocoded_at: '2026-05-16T10:00:00.000Z',
  });
  assert.equal(cols.venue_postcode, 'SW1A 1AA');
  assert.equal(cols.venue_lat, 51.5);
  assert.equal(cols.venue_lng, -0.14);
  assert.equal(cols.venue_geocode_status, 'success');
  assert.equal(cols.venue_geocoded_at, '2026-05-16T10:00:00.000Z');
});

test('geocodeColumns: success with area name (tier 3)', () => {
  const cols = geocodeColumns({
    status: 'success',
    area: 'Canary Wharf',
    lat: 51.5049,
    lng: -0.019,
    geocoded_at: '2026-05-16T10:00:00.000Z',
  });
  // Area name lands in venue_postcode so the dashboard has a label.
  assert.equal(cols.venue_postcode, 'Canary Wharf');
  assert.equal(cols.venue_lat, 51.5049);
  assert.equal(cols.venue_geocode_status, 'success');
});

test('geocodeColumns: failed clears lat/lng but keeps label', () => {
  const cols = geocodeColumns({ status: 'failed', postcode: 'ZZ1 9ZZ' });
  assert.equal(cols.venue_postcode, 'ZZ1 9ZZ');
  assert.equal(cols.venue_lat, null);
  assert.equal(cols.venue_lng, null);
  assert.equal(cols.venue_geocode_status, 'failed');
});

test('geocodeColumns: no_postcode + pending do not clobber lat/lng', () => {
  assert.deepEqual(
    geocodeColumns({ status: 'no_postcode' }),
    { venue_geocode_status: 'no_postcode' }
  );
  assert.deepEqual(
    geocodeColumns({ status: 'pending', error: 'timeout' }),
    { venue_geocode_status: 'pending' }
  );
  assert.deepEqual(
    geocodeColumns({ status: 'pending' }, { allowDowngrade: false }),
    {}
  );
});

// ── geocodePostcode (tier dispatch — stubbed network) ────────────────

function stubFetch(routes) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    for (const [match, response] of routes) {
      if (typeof match === 'string' ? u.includes(match) : match.test(u)) {
        if (typeof response === 'function') return response(u, init);
        return response;
      }
    }
    throw new Error(`stubFetch: no route matched ${u}`);
  };
  return () => { globalThis.fetch = orig; };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('geocodePostcode: tier 1 hits /postcodes for strict postcode', async () => {
  const restore = stubFetch([
    ['/postcodes/SW1A1AA', jsonResponse(200, {
      status: 200,
      result: { postcode: 'SW1A 1AA', latitude: 51.50101, longitude: -0.141563 },
    })],
  ]);
  try {
    const r = await geocodePostcode('SW1A 1AA');
    assert.equal(r.status, 'success');
    assert.equal(r.postcode, 'SW1A 1AA');
    assert.equal(r.lat, 51.50101);
    assert.equal(r.lng, -0.141563);
  } finally { restore(); }
});

test('geocodePostcode: tier 2 falls back to /outcodes for bare outcode', async () => {
  const restore = stubFetch([
    ['/outcodes/EC2A', jsonResponse(200, {
      status: 200,
      result: { outcode: 'EC2A', latitude: 51.5237, longitude: -0.0854 },
    })],
  ]);
  try {
    const r = await geocodePostcode('EC2A');
    assert.equal(r.status, 'success');
    assert.equal(r.postcode, 'EC2A');
    assert.equal(r.lat, 51.5237);
  } finally { restore(); }
});

test('geocodePostcode: tier 3 falls back to Nominatim for area name', async () => {
  const restore = stubFetch([
    ['nominatim', jsonResponse(200, [
      {
        lat: '51.5049',
        lon: '-0.019',
        addresstype: 'suburb',
        name: 'Canary Wharf',
      },
    ])],
  ]);
  try {
    const r = await geocodePostcode('Canary Wharf');
    assert.equal(r.status, 'success');
    assert.equal(r.area, 'Canary Wharf');
    assert.ok(Math.abs(r.lat - 51.5049) < 0.001);
    assert.ok(Math.abs(r.lng - (-0.019)) < 0.001);
  } finally { restore(); }
});

test('geocodePostcode: rejects low-quality Nominatim hits (random clubs etc.)', async () => {
  // "North London" returns a club called TeamSport — addresstype 'club'.
  const restore = stubFetch([
    ['nominatim', jsonResponse(200, [
      { lat: '51.6', lon: '-0.04', addresstype: 'club', name: 'TeamSport Edmonton' },
    ])],
  ]);
  try {
    const r = await geocodePostcode('North London');
    assert.equal(r.status, 'failed');
    assert.equal(r.area, 'North London');
  } finally { restore(); }
});

test('geocodePostcode: tier 1 failure cascades to tier 3', async () => {
  // 8-char input that fails the postcode lookup (404), then succeeds as place.
  const restore = stubFetch([
    ['/postcodes/', jsonResponse(404, { status: 404, error: 'not found' })],
    ['nominatim', jsonResponse(200, [
      { lat: '53.4789', lon: '-2.2453', addresstype: 'city', name: 'Manchester' },
    ])],
  ]);
  try {
    const r = await geocodePostcode('MANCHESTR'); // 9 chars triggers tier 1
    // tier 1 returns 'failed', tier 3 returns 'success'
    assert.equal(r.status, 'success');
    assert.equal(r.area, 'MANCHESTR');
  } finally { restore(); }
});

test('geocodePostcode: garbage input returns no_postcode', async () => {
  // No fetch should fire — all tiers reject input shape.
  const restore = stubFetch([
    [/./, () => { throw new Error('no network expected'); }],
  ]);
  try {
    assert.deepEqual(await geocodePostcode(''),    { status: 'no_postcode' });
    assert.deepEqual(await geocodePostcode(null),  { status: 'no_postcode' });
    assert.deepEqual(await geocodePostcode('x'),   { status: 'no_postcode' });
    assert.deepEqual(await geocodePostcode('##'),  { status: 'no_postcode' });
  } finally { restore(); }
});

test('geocodePostcode: transient 5xx surfaces as pending (preserved across tiers)', async () => {
  // Tier 1 → 503 (pending), Tier 3 → no result (failed). We expect the
  // pending state to win so transient outages drop the lead into the
  // 'pending' bucket rather than 'failed' for manual correction.
  const restore = stubFetch([
    ['/postcodes/', jsonResponse(503, {})],
    ['nominatim',   jsonResponse(200, [])],
  ]);
  try {
    const r = await geocodePostcode('SW1A 1AA');
    assert.equal(r.status, 'pending');
    assert.match(r.error, /HTTP 503/);
  } finally { restore(); }
});

test('geocodePostcode: tier 1 success short-circuits — never calls Nominatim', async () => {
  let nominatimCalled = 0;
  const restore = stubFetch([
    ['/postcodes/SW1A1AA', jsonResponse(200, {
      status: 200,
      result: { postcode: 'SW1A 1AA', latitude: 51.5, longitude: -0.14 },
    })],
    ['nominatim', () => { nominatimCalled++; return jsonResponse(200, []); }],
  ]);
  try {
    const r = await geocodePostcode('SW1A 1AA');
    assert.equal(r.status, 'success');
    assert.equal(nominatimCalled, 0, 'Nominatim should not be called when tier 1 succeeds');
  } finally { restore(); }
});

// ── PLACE_ADDRESS_TYPES sanity ───────────────────────────────────────

test('PLACE_ADDRESS_TYPES: covers expected settlement types', () => {
  for (const t of ['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet', 'borough']) {
    assert.ok(PLACE_ADDRESS_TYPES.has(t), `should accept ${t}`);
  }
  for (const t of ['club', 'building', 'road', 'shop']) {
    assert.ok(!PLACE_ADDRESS_TYPES.has(t), `should reject ${t}`);
  }
});
