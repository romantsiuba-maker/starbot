// GET /api/leads/:id/activity
// Unified activity feed: form_submission, status_change, email_*, note, file,
// call, whatsapp_*  - sorted DESC by timestamp.
//
// The merge happens in Postgres via the starbot_lead_activity(lead_id)
// function defined in migration-activity-timeline.sql, so we keep one
// round-trip and let the planner use the (lead_id, *) indexes.

import { createClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid lead id" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("/api/leads/[id]/activity: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const sb = createClient(url, key);
    const { data, error } = await sb.rpc("starbot_lead_activity", { p_lead_id: id });
    if (error) {
      console.error("/api/leads/[id]/activity: rpc failed", error.message);
      return res.status(500).json({ error: "Query failed" });
    }

    // Reshape the function output into the brief's contract.
    const activity = (data || []).map((row) => ({
      id: row.id,
      type: row.type,
      timestamp: row.ts,
      payload: row.payload || {},
    }));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ activity });
  } catch (err) {
    console.error("/api/leads/[id]/activity: unexpected", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
