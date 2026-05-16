// GET /api/leads/no-location
// Side-panel feed: leads that haven't been mapped yet — geocode failed,
// had no postcode, or is in transient pending state.

import { createClient } from "@supabase/supabase-js";

const SELECT_COLS =
  "id, name, phone, status, venue_type, venue_postcode, last_activity_at, source, venue_geocode_status";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("/api/leads/no-location: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const sb = createClient(url, key);
    const { data, error } = await sb
      .from("starbot_leads")
      .select(SELECT_COLS)
      .in("venue_geocode_status", ["failed", "no_postcode", "pending"])
      .not("status", "in", "(won,lost,dead)")
      .order("last_activity_at", { ascending: false, nullsFirst: false });

    if (error) {
      console.error("/api/leads/no-location: query failed", error.message);
      return res.status(500).json({ error: "Query failed" });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ leads: data || [] });
  } catch (err) {
    console.error("/api/leads/no-location: unexpected", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
