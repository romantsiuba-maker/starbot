#!/usr/bin/env node
// Backfill phone_e164, lead_ref_code, match_state, archive_status on
// pre-existing starbot_leads rows. Run after migration-whatsapp-schema.sql.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node backfill-whatsapp-schema.mjs
//
// Idempotent: only fills fields that are currently NULL. Safe to re-run.

import { createClient } from '@supabase/supabase-js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (falls back to SUPABASE_SERVICE_KEY).'
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// 8-char codes from an alphabet that excludes 0, O, 1, I, L.
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const REF_LENGTH = 8;

function generateRefCode() {
  const bytes = randomBytes(REF_LENGTH);
  let out = '';
  for (let i = 0; i < REF_LENGTH; i++) {
    out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return out;
}

function normalisePhone(raw) {
  if (!raw) return null;
  try {
    const parsed = parsePhoneNumberFromString(String(raw).trim(), 'GB');
    if (parsed && parsed.isValid()) return parsed.number; // E.164 format
  } catch {
    // fall through
  }
  return null;
}

async function loadExistingRefCodes() {
  const existing = new Set();
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from('starbot_leads')
      .select('lead_ref_code')
      .not('lead_ref_code', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) existing.add(row.lead_ref_code);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return existing;
}

async function main() {
  const existingRefs = await loadExistingRefCodes();

  let scanned = 0;
  let updated = 0;
  let phoneNormalised = 0;
  let phoneUnparseable = 0;
  let refCollisions = 0;

  let from = 0;
  const pageSize = 500;

  while (true) {
    const { data: rows, error } = await sb
      .from('starbot_leads')
      .select(
        'id, phone, phone_e164, lead_ref_code, match_state, archive_status'
      )
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!rows || rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const patch = {};

      if (!row.phone_e164 && row.phone) {
        const e164 = normalisePhone(row.phone);
        if (e164) {
          patch.phone_e164 = e164;
          phoneNormalised += 1;
        } else {
          phoneUnparseable += 1;
        }
      }

      if (!row.lead_ref_code) {
        let code;
        let attempts = 0;
        do {
          code = generateRefCode();
          attempts += 1;
          if (attempts > 1) refCollisions += 1;
        } while (existingRefs.has(code) && attempts < 25);
        existingRefs.add(code);
        patch.lead_ref_code = code;
      }

      if (!row.match_state) patch.match_state = 'form_only';
      if (!row.archive_status) patch.archive_status = 'active';

      if (Object.keys(patch).length === 0) continue;

      const { error: upErr } = await sb
        .from('starbot_leads')
        .update(patch)
        .eq('id', row.id);
      if (upErr) {
        console.error(`Failed to update ${row.id}: ${upErr.message}`);
        continue;
      }
      updated += 1;
    }

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  console.log('Backfill complete.');
  console.log(`  rows scanned:        ${scanned}`);
  console.log(`  rows updated:        ${updated}`);
  console.log(`  phones to E.164:     ${phoneNormalised}`);
  console.log(`  phones unparseable:  ${phoneUnparseable}`);
  console.log(`  ref-code retries:    ${refCollisions}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
