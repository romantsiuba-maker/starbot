// POST /api/leads/:id/postcode
// Manual backfill from the dashboard side panel. Body: { postcode }.
// Server-side geocodes via postcodes.io and patches the lead row.
// Returns the four geocode fields so the client can update its state
// without a separate refetch.

import { createClient } from "@supabase/supabase-js";
import { geocodePostcode, geocodeColumns } from "../../../lib/postcodes.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid lead id" });
  }

  const body = req.body || {};
  const rawPostcode = typeof body.postcode === "string" ? body.postcode : null;
  if (!rawPostcode || !rawPostcode.trim()) {
    return res.status(400).json({ error: "Missing postcode" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("/api/leads/[id]/postcode: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  let geocode;
  try {
    geocode = await geocodePostcode(rawPostcode);
  } catch (err) {
    console.error("/api/leads/[id]/postcode: geocode threw", err);
    return res.status(502).json({ error: "Geocoder unavailable" });
  }

  // For manual backfill, treat 'pending' as a hard upstream failure rather
  // than a soft fallback — the user is sitting in front of the dashboard
  // waiting for the dot to appear and deserves a real error, not a silent
  // 'pending'.
  if (geocode.status === "pending") {
    return res.status(502).json({ error: "Geocoder unavailable", detail: geocode.error });
  }

  const patch = {
    ...geocodeColumns(geocode),
    last_activity_at: new Date().toISOString(),
  };

  try {
    const sb = createClient(url, key);
    const { data, error } = await sb
      .from("starbot_leads")
      .update(patch)
      .eq("id", id)
      .select("venue_postcode, venue_lat, venue_lng, venue_geocode_status, venue_geocoded_at")
      .maybeSingle();

    if (error) {
      console.error("/api/leads/[id]/postcode: update failed", error.message);
      return res.status(500).json({ error: "Update failed" });
    }
    if (!data) return res.status(404).json({ error: "Lead not found" });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (err) {
    console.error("/api/leads/[id]/postcode: unexpected", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
