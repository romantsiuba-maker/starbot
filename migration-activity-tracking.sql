-- Migration: Add activity tracking columns to starbot_leads
-- Run this in Supabase SQL Editor before deploying the code changes.

-- 1. Add columns
ALTER TABLE starbot_leads
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz DEFAULT NULL;

-- 2. Backfill existing rows: set last_activity_at to the most recent known timestamp
UPDATE starbot_leads
SET last_activity_at = COALESCE(updated_at, created_at);

-- 3. Enable Realtime on starbot_leads (required for dashboard live updates)
-- If the table is not already in the publication, add it:
ALTER PUBLICATION supabase_realtime ADD TABLE starbot_leads;

-- 4. Create Storage bucket for file attachments
-- Run this in Supabase SQL Editor, or create via Storage dashboard:
INSERT INTO storage.buckets (id, name, public)
VALUES ('lead-attachments', 'lead-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- 5. Allow public read access to lead-attachments bucket
CREATE POLICY "Public read lead-attachments"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'lead-attachments');

-- 6. Allow authenticated users to upload to lead-attachments
CREATE POLICY "Authenticated upload lead-attachments"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'lead-attachments');
