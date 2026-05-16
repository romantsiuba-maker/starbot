// POST /api/leads/:id/call-log
// Logs a manual phone call against a lead. Authenticates via the user's
// Supabase JWT (sent as Authorization: Bearer <access_token>) so the row's
// logged_by reflects the actual operator, then inserts with the service-role
// client to avoid RLS friction on the new table.

import { createClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECTIONS = new Set(["inbound", "outbound"]);
const OUTCOMES = new Set([
  "answered",
  "voicemail",
  "no_answer",
  "rejected",
  "wrong_number",
]);

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
  const direction = typeof body.direction === "string" ? body.direction : null;
  const outcome = typeof body.outcome === "string" ? body.outcome : null;
  const duration = body.duration_seconds;
  const notes = typeof body.notes === "string" && body.notes.trim()
    ? body.notes.trim()
    : null;

  if (!direction || !DIRECTIONS.has(direction)) {
    return res.status(400).json({ error: "Invalid direction" });
  }
  if (!outcome || !OUTCOMES.has(outcome)) {
    return res.status(400).json({ error: "Invalid outcome" });
  }
  let durationValue = null;
  if (duration !== undefined && duration !== null && duration !== "") {
    durationValue = Number(duration);
    if (!Number.isInteger(durationValue) || durationValue < 0) {
      return res.status(400).json({ error: "Invalid duration_seconds" });
    }
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("/api/leads/[id]/call-log: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  // Resolve logged_by from the bearer JWT. Failure -> null (call still logs
  // as system-attributed); we don't 401 manual call entries.
  let loggedBy = null;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (token && anonKey) {
    try {
      const userClient = createClient(supabaseUrl, anonKey);
      const { data, error } = await userClient.auth.getUser(token);
      if (!error && data?.user?.id) loggedBy = data.user.id;
    } catch (err) {
      console.error("/api/leads/[id]/call-log: getUser failed", err);
    }
  }

  try {
    const sb = createClient(supabaseUrl, serviceKey);
    const { data, error } = await sb
      .from("starbot_call_logs")
      .insert({
        lead_id: id,
        direction,
        outcome,
        duration_seconds: durationValue,
        notes,
        logged_by: loggedBy,
      })
      .select("id, lead_id, direction, outcome, duration_seconds, notes, logged_by, created_at")
      .maybeSingle();

    if (error) {
      // Foreign key violations (lead doesn't exist) surface as 23503.
      if (error.code === "23503") {
        return res.status(404).json({ error: "Lead not found" });
      }
      console.error("/api/leads/[id]/call-log: insert failed", error.message);
      return res.status(500).json({ error: "Insert failed" });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (err) {
    console.error("/api/leads/[id]/call-log: unexpected", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
