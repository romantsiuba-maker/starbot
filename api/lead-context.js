// Public endpoint: GET /api/lead-context?ref={lead_ref_code}
// Returns { name, venue } when ref is valid and a matching lead exists.
// Returns 404 silently for missing/invalid/not-found refs (so this can't
// be used as a ref-code oracle, e.g. to confirm whether a code exists by
// the difference between 200 and 4xx).
//
// MUST NOT return any other lead data. Treated as a public endpoint.

import { createClient } from "@supabase/supabase-js";

const REF_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const refRaw = req.query?.ref;
  const ref = typeof refRaw === "string" ? refRaw.toUpperCase() : null;
  if (!ref || !REF_RE.test(ref)) {
    return res.status(404).end();
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("/api/lead-context: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const sb = createClient(url, key);
    const { data, error } = await sb
      .from("starbot_leads")
      .select("first_name, company")
      .eq("lead_ref_code", ref)
      .maybeSingle();

    if (error) {
      console.error("/api/lead-context: query failed", error.message);
      return res.status(404).end();
    }
    if (!data) return res.status(404).end();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      name: data.first_name || null,
      venue: data.company || null,
    });
  } catch (err) {
    console.error("/api/lead-context: unexpected error", err);
    return res.status(404).end();
  }
}
