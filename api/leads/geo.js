// GET /api/leads/geo
// Map dots feed: successfully-geocoded, non-archived leads.

import { createClient } from "@supabase/supabase-js";

const SELECT_COLS =
  "id, name, phone, status, venue_type, venue_postcode, venue_lat, venue_lng, last_activity_at, source";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("/api/leads/geo: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const sb = createClient(url, key);
    // PR 50: don't exclude won/lost/dead — the 3-colour traffic light on
    // the map needs green dots for won leads and red dots for lost/dead.
    const { data, error } = await sb
      .from("starbot_leads")
      .select(SELECT_COLS)
      .eq("venue_geocode_status", "success")
      .not("venue_lat", "is", null)
      .not("venue_lng", "is", null);

    if (error) {
      console.error("/api/leads/geo: query failed", error.message);
      return res.status(500).json({ error: "Query failed" });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ leads: data || [] });
  } catch (err) {
    console.error("/api/leads/geo: unexpected", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
