-- Migration: activity timeline foundations (PR 47)
--
-- Adds two tables that feed the unified lead activity timeline:
--   starbot_call_logs       - manual phone-call records
--   starbot_status_history  - one row per status change on starbot_leads
--
-- Also installs:
--   trigger on starbot_leads UPDATE  -> insert into starbot_status_history
--   trigger on starbot_call_logs     -> bump last_activity_at on parent lead
--   backfill of one status_history row per existing lead (initial state)
--
-- Idempotent. Safe to re-run.

-- 1. starbot_call_logs --------------------------------------------------------

CREATE TABLE IF NOT EXISTS starbot_call_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          uuid        NOT NULL REFERENCES starbot_leads(id) ON DELETE CASCADE,
  direction        text        NOT NULL,
  duration_seconds integer,
  outcome          text        NOT NULL,
  notes            text,
  logged_by        uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE starbot_call_logs
    ADD CONSTRAINT starbot_call_logs_direction_chk
    CHECK (direction IN ('inbound', 'outbound'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE starbot_call_logs
    ADD CONSTRAINT starbot_call_logs_outcome_chk
    CHECK (outcome IN ('answered', 'voicemail', 'no_answer', 'rejected', 'wrong_number'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE starbot_call_logs
    ADD CONSTRAINT starbot_call_logs_duration_chk
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS starbot_call_logs_lead_created_idx
  ON starbot_call_logs (lead_id, created_at DESC);

-- 2. starbot_status_history --------------------------------------------------

CREATE TABLE IF NOT EXISTS starbot_status_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid        NOT NULL REFERENCES starbot_leads(id) ON DELETE CASCADE,
  from_status text,
  to_status   text        NOT NULL,
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS starbot_status_history_lead_changed_idx
  ON starbot_status_history (lead_id, changed_at DESC);

-- 3. Trigger: status change inserts a row into status_history ----------------

CREATE OR REPLACE FUNCTION public.starbot_leads_log_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.starbot_status_history (lead_id, from_status, to_status, changed_by, changed_at)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS starbot_leads_log_status_change ON public.starbot_leads;

CREATE TRIGGER starbot_leads_log_status_change
  AFTER UPDATE ON public.starbot_leads
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.starbot_leads_log_status_change();

-- 4. Trigger: call_log insert bumps parent lead's last_activity_at -----------

CREATE OR REPLACE FUNCTION public.starbot_call_logs_bump_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.starbot_leads
  SET last_activity_at = COALESCE(NEW.created_at, now())
  WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS starbot_call_logs_bump_activity ON public.starbot_call_logs;

CREATE TRIGGER starbot_call_logs_bump_activity
  AFTER INSERT ON public.starbot_call_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.starbot_call_logs_bump_activity();

-- 5. Backfill: one initial status_history row per existing lead --------------
-- Idempotent guard: only insert when there isn't already a history row for
-- this lead, so re-running the migration does not duplicate the seed.

INSERT INTO starbot_status_history (lead_id, from_status, to_status, changed_by, changed_at)
SELECT l.id, NULL, COALESCE(l.status, 'new'), NULL, l.created_at
FROM starbot_leads l
WHERE NOT EXISTS (
  SELECT 1 FROM starbot_status_history h WHERE h.lead_id = l.id
);

-- 6. Backfill: migrate existing Call entries from conversation_log -----------
-- The 5 'Call' tag entries in the legacy conversation_log become rows in
-- starbot_call_logs (outcome 'answered', notes from text, logged_by NULL).
-- Idempotent guard: skip if a call_log row already exists at the same
-- (lead_id, created_at) so re-running doesn't duplicate.

WITH legacy_calls AS (
  SELECT l.id AS lead_id,
         (entry->>'date')::timestamptz AS created_at,
         entry->>'text' AS notes
  FROM starbot_leads l,
       jsonb_array_elements(COALESCE(l.conversation_log, '[]'::jsonb)) AS entry
  WHERE entry->>'tag' = 'Call'
)
INSERT INTO starbot_call_logs (lead_id, direction, outcome, duration_seconds, notes, logged_by, created_at)
SELECT lead_id, 'outbound', 'answered', NULL, notes, NULL, created_at
FROM legacy_calls lc
WHERE NOT EXISTS (
  SELECT 1 FROM starbot_call_logs c
  WHERE c.lead_id = lc.lead_id AND c.created_at = lc.created_at
);

-- 7. Activity feed function --------------------------------------------------
-- Single UNION ALL across every activity source so the API endpoint can
-- call `sb.rpc('starbot_lead_activity', { p_lead_id: ... })` and rely on
-- the planner to use the (lead_id, created_at DESC) and (lead_id, changed_at
-- DESC) indexes plus the jsonb_array_elements pass over conversation_log.
--
-- Returns one row per activity item with a `type` discriminator and a
-- jsonb `payload` for type-specific fields.

CREATE OR REPLACE FUNCTION public.starbot_lead_activity(p_lead_id uuid)
RETURNS TABLE (
  id        uuid,
  type      text,
  ts        timestamptz,
  payload   jsonb
)
LANGUAGE sql
STABLE
AS $$
  -- form_submission: synthesised from the lead row itself
  SELECT
    l.id                                                  AS id,
    'form_submission'::text                               AS type,
    l.created_at                                          AS ts,
    jsonb_build_object(
      'source',       l.source,
      'utm_source',   l.utm_source,
      'utm_medium',   l.utm_medium,
      'utm_campaign', l.utm_campaign,
      'utm_content',  l.utm_content
    )                                                     AS payload
  FROM starbot_leads l
  WHERE l.id = p_lead_id

  UNION ALL

  -- status_change: every entry in starbot_status_history
  SELECT
    h.id                                                  AS id,
    'status_change'::text                                 AS type,
    h.changed_at                                          AS ts,
    jsonb_build_object(
      'from_status', h.from_status,
      'to_status',   h.to_status,
      'changed_by',  h.changed_by
    )                                                     AS payload
  FROM starbot_status_history h
  WHERE h.lead_id = p_lead_id

  UNION ALL

  -- email_outbound, email_inbound, note, file: from conversation_log JSONB.
  -- 'Email' from roman -> outbound; 'Email' from lead -> inbound (rare).
  -- 'Reply' from lead -> inbound; 'Reply' from roman -> outbound (Resend
  -- attaches replies to Resend ids; this is the existing data shape).
  SELECT
    -- Synthesise a stable id from lead + entry index so the client can dedupe.
    (md5(p_lead_id::text || '|' || ord::text)::uuid)      AS id,
    CASE
      WHEN entry->>'tag' = 'Note'                       THEN 'note'
      WHEN entry->>'tag' = 'File'                       THEN 'file'
      WHEN entry->>'tag' IN ('Email', 'Reply')
        AND entry->>'from' = 'lead'                     THEN 'email_inbound'
      WHEN entry->>'tag' IN ('Email', 'Reply')          THEN 'email_outbound'
      WHEN entry->>'tag' = 'Meeting'                    THEN 'note'
      ELSE 'note'
    END                                                   AS type,
    COALESCE((entry->>'date')::timestamptz, now())        AS ts,
    jsonb_build_object(
      'from',     entry->>'from',
      'tag',      entry->>'tag',
      'subject',  entry->>'subject',
      'text',     entry->>'text'
    )                                                     AS payload
  FROM starbot_leads l,
       jsonb_array_elements(COALESCE(l.conversation_log, '[]'::jsonb))
         WITH ORDINALITY AS arr(entry, ord)
  WHERE l.id = p_lead_id
    AND entry->>'tag' IN ('Note', 'File', 'Email', 'Reply', 'Meeting')

  UNION ALL

  -- call: starbot_call_logs
  SELECT
    c.id                                                  AS id,
    'call'::text                                          AS type,
    c.created_at                                          AS ts,
    jsonb_build_object(
      'direction',        c.direction,
      'outcome',          c.outcome,
      'duration_seconds', c.duration_seconds,
      'notes',            c.notes,
      'logged_by',        c.logged_by
    )                                                     AS payload
  FROM starbot_call_logs c
  WHERE c.lead_id = p_lead_id

  UNION ALL

  -- whatsapp_inbound / whatsapp_outbound: starbot_whatsapp_messages.
  -- Forward-compatible with PR 42; returns 0 rows until ingest starts.
  -- The table exists today via PR 1, so the query is safe right now.
  SELECT
    m.id                                                  AS id,
    CASE WHEN m.direction = 'inbound'
         THEN 'whatsapp_inbound' ELSE 'whatsapp_outbound' END AS type,
    COALESCE(m."timestamp", m.created_at)                 AS ts,
    jsonb_build_object(
      'wa_message_id', m.wa_message_id,
      'wa_id',         m.wa_id,
      'direction',     m.direction,
      'body',          m.body,
      'media_url',     m.media_url,
      'status',        m.status
    )                                                     AS payload
  FROM starbot_whatsapp_messages m
  WHERE m.lead_id = p_lead_id

  ORDER BY ts DESC;
$$;

GRANT EXECUTE ON FUNCTION public.starbot_lead_activity(uuid) TO authenticated;

-- 8. Remove migrated Call entries from conversation_log ----------------------
-- We strip only tag='Call' entries; Meeting/Note/Email/Reply/File stay put.

UPDATE starbot_leads
SET conversation_log = (
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(conversation_log, '[]'::jsonb)) entry
  WHERE entry->>'tag' IS DISTINCT FROM 'Call'
)
WHERE conversation_log @? '$[*] ? (@.tag == "Call")';
