#!/usr/bin/env node
// Live integration check against postcodes.io + Nominatim.
// Not run in CI (network-dependent, rate-limit-sensitive).
// Run manually:   node test-postcodes-live.mjs

import { geocodePostcode } from './lib/postcodes.js';

const cases = [
  // [input, expected status, expected lat, expected lng, tolerance]
  { input: 'SW1A 1AA',     status: 'success', lat: 51.5014, lng: -0.1419, tol: 0.01 },
  { input: 'Canary Wharf', status: 'success', lat: 51.5054, lng: -0.0235, tol: 0.05 },
  { input: 'EC2A 4DP',     status: 'success', lat: 51.521,  lng: -0.082,  tol: 0.02 },
  { input: 'EC2A',         status: 'success', lat: 51.5237, lng: -0.0854, tol: 0.02 },
  { input: 'Manchester',   status: 'success', lat: 53.479,  lng: -2.245,  tol: 0.5 },
  { input: 'xqzwfgz',      status: 'failed' },
  { input: '',             status: 'no_postcode' },
];

let pass = 0, fail = 0;

for (const c of cases) {
  // Brief throttle to play nice with Nominatim's 1 req/sec policy.
  await new Promise((r) => setTimeout(r, 1100));
  const got = await geocodePostcode(c.input);
  const ok =
    got.status === c.status &&
    (c.lat == null || Math.abs(got.lat - c.lat) <= c.tol) &&
    (c.lng == null || Math.abs(got.lng - c.lng) <= c.tol);
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  console.log(
    `[${tag}] ${JSON.stringify(c.input).padEnd(16)} -> ` +
      `status=${got.status}` +
      (got.lat ? ` lat=${got.lat.toFixed(4)} lng=${got.lng.toFixed(4)}` : '') +
      (got.postcode ? ` postcode=${got.postcode}` : '') +
      (got.area ? ` area=${got.area}` : '')
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
