-- Migration: last_activity_at trigger (PR 2)
--
-- Adds a BEFORE UPDATE trigger that bumps last_activity_at = now() whenever
-- any of {notes, status, venue_type, archive_status} changes. Mercury fields
-- (mercury_summary, mercury_flags, mercury_last_run_at) are intentionally
-- excluded so background AI summarisation does not count as lead activity.
--
-- Idempotent: drops the trigger first if it exists, then recreates the
-- function and trigger.

CREATE OR REPLACE FUNCTION public.update_starbot_leads_last_activity_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.last_activity_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS starbot_leads_last_activity_at ON public.starbot_leads;

CREATE TRIGGER starbot_leads_last_activity_at
  BEFORE UPDATE ON public.starbot_leads
  FOR EACH ROW
  WHEN (
    NEW.notes          IS DISTINCT FROM OLD.notes          OR
    NEW.status         IS DISTINCT FROM OLD.status         OR
    NEW.venue_type     IS DISTINCT FROM OLD.venue_type     OR
    NEW.archive_status IS DISTINCT FROM OLD.archive_status
  )
  EXECUTE FUNCTION public.update_starbot_leads_last_activity_at();
