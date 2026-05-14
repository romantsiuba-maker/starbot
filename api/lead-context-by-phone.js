// Public endpoint: GET /api/lead-context-by-phone?phone={raw_phone}
//
// Normalises the input to E.164 (libphonenumber-js, default region GB),
// looks up the most recent starbot_leads row with that phone_e164, and
// returns { name, venue, ref_code }. Returns 404 silently for any failure
// path so the endpoint can't be used as a phone-existence oracle.
//
// MUST NOT return any other lead data. Same privacy contract as
// /api/lead-context: only name, venue, ref_code ever leave the endpoint.
//
// NOTE: this endpoint is reachable from any origin. Phone-number space
// is enumerable in principle; in practice the response only carries
// public marketing-friendly fields and the ref_code can't be used to
// impersonate a lead because the PR 4 inbound WhatsApp webhook matches
// on phone first, not on ref.

import { createClient } from "@supabase/supabase-js";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const phoneRaw = req.query?.phone;
  if (typeof phoneRaw !== "string" || !phoneRaw.trim()) {
    return res.status(404).end();
  }

  const e164 = normalisePhone(phoneRaw);
  if (!e164) return res.status(404).end();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("/api/lead-context-by-phone: Supabase env not configured");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const sb = createClient(url, key);
    const { data, error } = await sb
      .from("starbot_leads")
      .select("first_name, company, lead_ref_code")
      .eq("phone_e164", e164)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return res.status(404).end();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      name: data.first_name || null,
      venue: data.company || null,
      ref_code: data.lead_ref_code || null,
    });
  } catch (err) {
    console.error("/api/lead-context-by-phone: unexpected error", err);
    return res.status(404).end();
  }
}

function normalisePhone(raw) {
  try {
    const p = parsePhoneNumberFromString(String(raw).trim(), "GB");
    if (p && p.isValid()) return p.number;
  } catch {
    // fall through
  }
  return null;
}

export const __test__ = { normalisePhone };
