#!/usr/bin/env node
// Verify that migration-whatsapp-schema.sql applied cleanly and that
// every starbot_leads row has non-null required fields after backfill.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node verify-whatsapp-schema.mjs
//
// Exits non-zero if any check fails. This is the "test" for PR 1.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const NEW_LEAD_COLUMNS = [
  'phone_e164',
  'lead_ref_code',
  'whatsapp_thread_id',
  'whatsapp_wa_id',
  'match_state',
  'archive_status',
  'venue_type',
  'stage_entered_at',
  'last_activity_at',
  'mercury_summary',
  'mercury_flags',
  'mercury_last_run_at',
];

const REQUIRED_NON_NULL = ['lead_ref_code', 'match_state', 'archive_status'];

const REF_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

let failed = false;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed = true;
}

function pass(msg) {
  console.log(`ok:   ${msg}`);
}

// 1. All new columns present (a missing column would surface as an error).
{
  const { error } = await sb
    .from('starbot_leads')
    .select(NEW_LEAD_COLUMNS.join(','))
    .limit(1);
  if (error) fail(`starbot_leads column check: ${error.message}`);
  else pass(`starbot_leads has all ${NEW_LEAD_COLUMNS.length} new columns`);
}

// 2. starbot_whatsapp_messages table reachable.
{
  const { error } = await sb
    .from('starbot_whatsapp_messages')
    .select('id, lead_id, wa_message_id, wa_id, direction, body, media_url, timestamp, status, created_at')
    .limit(1);
  if (error) fail(`starbot_whatsapp_messages check: ${error.message}`);
  else pass('starbot_whatsapp_messages reachable with all expected columns');
}

// 3. Required fields are non-null on every existing row.
for (const field of REQUIRED_NON_NULL) {
  const { count, error } = await sb
    .from('starbot_leads')
    .select('id', { count: 'exact', head: true })
    .is(field, null);
  if (error) {
    fail(`${field} null count: ${error.message}`);
    continue;
  }
  if (count === 0) pass(`${field}: 0 null rows`);
  else fail(`${field}: ${count} row(s) still NULL`);
}

// 4. archive_status values within allowed set.
{
  const allowed = ['active', 'parked', 'won', 'lost', 'dead'];
  const { data, error } = await sb
    .from('starbot_leads')
    .select('archive_status')
    .not('archive_status', 'in', `(${allowed.map((v) => `"${v}"`).join(',')})`);
  if (error) fail(`archive_status enum check: ${error.message}`);
  else if (data && data.length > 0)
    fail(`archive_status enum: ${data.length} row(s) out of range`);
  else pass('archive_status values within allowed set');
}

// 5. match_state values within allowed set.
{
  const allowed = ['form_only', 'whatsapp_only', 'matched'];
  const { data, error } = await sb
    .from('starbot_leads')
    .select('match_state')
    .not('match_state', 'in', `(${allowed.map((v) => `"${v}"`).join(',')})`);
  if (error) fail(`match_state enum check: ${error.message}`);
  else if (data && data.length > 0)
    fail(`match_state enum: ${data.length} row(s) out of range`);
  else pass('match_state values within allowed set');
}

// 6. lead_ref_code shape + uniqueness across all rows.
{
  const codes = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from('starbot_leads')
      .select('lead_ref_code')
      .not('lead_ref_code', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) {
      fail(`lead_ref_code fetch: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data) codes.push(row.lead_ref_code);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const seen = new Set();
  let dupes = 0;
  let badShape = 0;
  for (const code of codes) {
    if (!REF_CODE_RE.test(code)) badShape += 1;
    if (seen.has(code)) dupes += 1;
    seen.add(code);
  }
  if (badShape || dupes) {
    fail(
      `lead_ref_code: bad shape ${badShape}, duplicates ${dupes} across ${codes.length} rows`
    );
  } else {
    pass(`lead_ref_code: ${codes.length} valid, unique`);
  }
}

// 7. Phone parity: every row with a non-empty phone should now have phone_e164.
{
  const { data, error } = await sb
    .from('starbot_leads')
    .select('id, phone, phone_e164')
    .not('phone', 'is', null);
  if (error) {
    fail(`phone parity check: ${error.message}`);
  } else {
    const missing = (data || []).filter(
      (r) => r.phone && r.phone.trim() !== '' && !r.phone_e164
    );
    if (missing.length === 0) {
      pass(`phone parity: every row with phone also has phone_e164 (${(data || []).length} rows)`);
    } else {
      // Unparseable legacy data is possible; surface for review but fail.
      fail(
        `phone parity: ${missing.length} row(s) have phone but no phone_e164 (likely unparseable, inspect manually)`
      );
    }
  }
}

if (failed) {
  console.error('\nverify-whatsapp-schema: FAILED');
  process.exit(1);
}
console.log('\nverify-whatsapp-schema: PASSED');
