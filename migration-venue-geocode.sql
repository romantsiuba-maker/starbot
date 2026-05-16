-- Migration: venue postcode + lat/lng for the map view (PR 48)
--
-- Adds five columns to starbot_leads so each lead can carry its venue
-- coordinates, with a check-constrained geocode status. Geocoding itself
-- is done in api/webhooks/meta-lead-ads.js via postcodes.io.
--
-- Idempotent: safe to re-run.

ALTER TABLE starbot_leads
  ADD COLUMN IF NOT EXISTS venue_postcode       text,
  ADD COLUMN IF NOT EXISTS venue_lat            double precision,
  ADD COLUMN IF NOT EXISTS venue_lng            double precision,
  ADD COLUMN IF NOT EXISTS venue_geocoded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS venue_geocode_status text DEFAULT 'no_postcode';

DO $$ BEGIN
  ALTER TABLE starbot_leads
    ADD CONSTRAINT starbot_leads_venue_geocode_status_chk
    CHECK (venue_geocode_status IS NULL OR venue_geocode_status IN
           ('success', 'failed', 'no_postcode', 'pending'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spatial bounding-box queries on (lat, lng).
CREATE INDEX IF NOT EXISTS starbot_leads_venue_latlng_idx
  ON starbot_leads (venue_lat, venue_lng);

-- Status filter for the no-location panel.
CREATE INDEX IF NOT EXISTS starbot_leads_venue_geocode_status_idx
  ON starbot_leads (venue_geocode_status);

-- Backfill: every existing lead (form did not ask for postcode) starts in
-- 'no_postcode' so it surfaces in the manual-backfill side panel. New leads
-- coming through the Meta webhook will set this column themselves.
UPDATE starbot_leads
SET venue_geocode_status = 'no_postcode'
WHERE venue_geocode_status IS NULL;
