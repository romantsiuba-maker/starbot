-- Migration: WhatsApp + match-state schema extensions (PR 1)
--
-- Run order:
--   1. Apply this file in the Supabase SQL Editor (idempotent, safe to re-run).
--   2. Run `node backfill-whatsapp-schema.mjs` against the same project to
--      populate phone_e164, lead_ref_code, match_state, archive_status on
--      pre-existing rows.
--   3. Run `node verify-whatsapp-schema.mjs` to confirm every row has the
--      non-null required fields.
--
-- The existing leads table is `starbot_leads` (namespaced for the shared
-- Supabase project). The new WhatsApp message table follows the same prefix.

-- 1. Columns on starbot_leads ------------------------------------------------

ALTER TABLE starbot_leads
  ADD COLUMN IF NOT EXISTS phone_e164          text,
  ADD COLUMN IF NOT EXISTS lead_ref_code       text,
  ADD COLUMN IF NOT EXISTS whatsapp_thread_id  text,
  ADD COLUMN IF NOT EXISTS whatsapp_wa_id      text,
  ADD COLUMN IF NOT EXISTS match_state         text,
  ADD COLUMN IF NOT EXISTS archive_status      text DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS venue_type          text,
  ADD COLUMN IF NOT EXISTS stage_entered_at    timestamptz,
  ADD COLUMN IF NOT EXISTS mercury_summary     text,
  ADD COLUMN IF NOT EXISTS mercury_flags       jsonb,
  ADD COLUMN IF NOT EXISTS mercury_last_run_at timestamptz;

-- last_activity_at already added by migration-activity-tracking.sql.

-- 2. Constraints (wrapped in DO blocks so the migration is idempotent) -------

DO $$ BEGIN
  ALTER TABLE starbot_leads
    ADD CONSTRAINT starbot_leads_lead_ref_code_key UNIQUE (lead_ref_code);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE starbot_leads
    ADD CONSTRAINT starbot_leads_match_state_chk
    CHECK (match_state IS NULL OR match_state IN ('form_only', 'whatsapp_only', 'matched'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE starbot_leads
    ADD CONSTRAINT starbot_leads_archive_status_chk
    CHECK (archive_status IN ('active', 'parked', 'won', 'lost', 'dead'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE starbot_leads
    ADD CONSTRAINT starbot_leads_venue_type_chk
    CHECK (venue_type IS NULL OR venue_type IN (
      'retail', 'office', 'hospitality', 'shopping_centre',
      'gym', 'transport_hub', 'education', 'other'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Indexes on starbot_leads ------------------------------------------------

CREATE INDEX IF NOT EXISTS starbot_leads_phone_e164_idx     ON starbot_leads (phone_e164);
CREATE INDEX IF NOT EXISTS starbot_leads_lead_ref_code_idx  ON starbot_leads (lead_ref_code);
CREATE INDEX IF NOT EXISTS starbot_leads_whatsapp_wa_id_idx ON starbot_leads (whatsapp_wa_id);
CREATE INDEX IF NOT EXISTS starbot_leads_archive_status_idx ON starbot_leads (archive_status);
CREATE INDEX IF NOT EXISTS starbot_leads_venue_type_idx     ON starbot_leads (venue_type);

-- 4. starbot_whatsapp_messages ----------------------------------------------

CREATE TABLE IF NOT EXISTS starbot_whatsapp_messages (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid        REFERENCES starbot_leads(id) ON DELETE SET NULL,
  wa_message_id text        UNIQUE,
  wa_id         text,
  direction     text        CHECK (direction IN ('inbound', 'outbound')),
  body          text,
  media_url     text,
  "timestamp"   timestamptz,
  status        text        CHECK (status IS NULL OR status IN ('sent', 'delivered', 'read', 'failed')),
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS starbot_whatsapp_messages_lead_id_idx ON starbot_whatsapp_messages (lead_id);
CREATE INDEX IF NOT EXISTS starbot_whatsapp_messages_wa_id_idx   ON starbot_whatsapp_messages (wa_id);
