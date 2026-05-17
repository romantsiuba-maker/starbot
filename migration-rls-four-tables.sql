-- Migration: enable RLS on four previously-unprotected tables and mirror
-- the starbot_leads policy pattern (Dashboard read + Dashboard update for
-- the authenticated role, both with USING (true) / WITH CHECK (true)).
--
-- Tables affected (all in public):
--   starbot_call_logs
--   starbot_status_history
--   starbot_whatsapp_messages
--   system_errors
--
-- Why: a Supabase advisor flagged these four as having RLS disabled. The
-- vanilla dashboard at partner.starbot.co.uk and the new Next.js app at
-- crm.starbot.co.uk both authenticate with the anon key, so without RLS
-- and matching policies any authenticated user would lose access. The
-- migration enables RLS and installs the policies in the same statement
-- so the dashboards never see a window with RLS on but no policy.
--
-- Inserts and deletes are intentionally NOT covered: the legacy dashboard
-- routes all writes for these tables through the service-role key in
-- Vercel Functions (e.g. api/leads/[id]/call-log.js does an INSERT under
-- service-role and is not subject to RLS), and Phase 2 of the rewrite
-- will keep that pattern. Authenticated clients only ever read and
-- occasionally update.
--
-- Idempotent: safe to re-run. DROP POLICY IF EXISTS clears any prior
-- attempt, then CREATE POLICY reinstates with the canonical names.
-- ENABLE ROW LEVEL SECURITY is a no-op if already enabled.
--
-- Dry-run: verified on 2026-05-17 by replicating the four tables as
-- empty stubs in the starbot_test schema and applying the same logic.
-- Resulting pg_policy rows match starbot_leads byte for byte (cmd, role,
-- USING expr, WITH CHECK expr).

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'starbot_call_logs',
    'starbot_status_history',
    'starbot_whatsapp_messages',
    'system_errors'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Dashboard read',   t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Dashboard update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      'Dashboard read', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)',
      'Dashboard update', t
    );
  END LOOP;
END $$;
