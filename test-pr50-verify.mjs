#!/usr/bin/env node
// PR 50 verification dry-run (run from local against prod Supabase).
//
// Inserts two test leads in public.starbot_leads with source='test:pr50:...',
// runs the geocoder library, patches the rows via SQL, prints the resulting
// rows, then DELETES the test rows. Non-destructive: only touches rows it
// just created.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (.env.local).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { geocodePostcode, geocodeColumns } from './lib/postcodes.js';

// Tiny .env.local loader so we don't drag in dotenv just for this script.
try {
  const env = readFileSync('.env.local', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error('missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

const sb = createClient(SB_URL, SB_KEY);

const TEST_TAG = 'test:pr50:postcode-pipeline';
const cases = [
  { input: 'SW1A 1AA',     expectLat: 51.5014, expectLng: -0.1419, tol: 0.01, status: 'new'   },
  { input: 'Canary Wharf', expectLat: 51.5054, expectLng: -0.0235, tol: 0.05, status: 'won'   },
];

const insertedIds = [];
let pass = 0, fail = 0;

async function cleanup() {
  if (insertedIds.length === 0) return;
  console.log('\nCleaning up test rows…');
  const { error } = await sb.from('starbot_leads').delete().in('id', insertedIds);
  if (error) console.error('cleanup failed:', error.message);
  else console.log(`Deleted ${insertedIds.length} test rows.`);
}

process.on('SIGINT', async () => { await cleanup(); process.exit(1); });

try {
  for (const c of cases) {
    console.log(`\n── ${c.input} (${c.status}) ───────────────`);
    const t0 = Date.now();

    // 1. Insert lead with raw venue_postcode, no lat/lng yet.
    const { data: ins, error: insErr } = await sb
      .from('starbot_leads')
      .insert({
        name: `PR50 Test ${c.input}`,
        first_name: 'PR50',
        last_name: 'Test',
        phone: '+447000000000',
        source: `${TEST_TAG}:${c.input.replace(/\s+/g, '')}`,
        status: c.status,
        venue_postcode: c.input,
        venue_geocode_status: 'no_postcode',
        archive_status: 'active',
        match_state: 'form_only',
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`insert failed: ${insErr.message}`);
    insertedIds.push(ins.id);
    console.log(`  inserted id=${ins.id}`);

    // 2. Geocode (this is the same code path the Meta webhook uses inline).
    const g = await geocodePostcode(c.input);
    console.log(`  geocode -> status=${g.status} lat=${g.lat?.toFixed(4)} lng=${g.lng?.toFixed(4)}`);

    // 3. Patch the row.
    const patch = geocodeColumns(g);
    const { error: upErr } = await sb
      .from('starbot_leads')
      .update(patch)
      .eq('id', ins.id);
    if (upErr) throw new Error(`update failed: ${upErr.message}`);

    // 4. Read it back, verify it'd be picked up by /api/leads/geo.
    const { data: row, error: readErr } = await sb
      .from('starbot_leads')
      .select('id,name,status,venue_postcode,venue_lat,venue_lng,venue_geocode_status')
      .eq('id', ins.id)
      .eq('venue_geocode_status', 'success')
      .not('venue_lat', 'is', null)
      .not('venue_lng', 'is', null)
      .maybeSingle();
    if (readErr) throw new Error(`read failed: ${readErr.message}`);

    const elapsed = Date.now() - t0;
    const ok = row &&
      Math.abs(row.venue_lat - c.expectLat) <= c.tol &&
      Math.abs(row.venue_lng - c.expectLng) <= c.tol;
    if (ok) {
      pass++;
      console.log(`  [PASS] venue_lat=${row.venue_lat.toFixed(4)} venue_lng=${row.venue_lng.toFixed(4)} (within ${c.tol}, ${elapsed}ms)`);
    } else {
      fail++;
      console.log(`  [FAIL] row=${JSON.stringify(row)}`);
    }
  }

  // 5. Confirm both rows surface in the /api/leads/geo query.
  const { data: feed } = await sb
    .from('starbot_leads')
    .select('id,name,status,venue_postcode,venue_lat,venue_lng')
    .eq('venue_geocode_status', 'success')
    .not('venue_lat', 'is', null)
    .not('venue_lng', 'is', null)
    .in('id', insertedIds);
  console.log(`\n/api/leads/geo would return ${feed?.length || 0}/${insertedIds.length} test rows`);

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await cleanup();
}

process.exit(fail ? 1 : 0);
