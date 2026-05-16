// Vercel serverless function: receives Meta Lead Ads webhook events,
// verifies the X-Hub-Signature-256 header, fetches the lead's field_data
// via Graph API, normalises the lead, and inserts a row into starbot_leads.
//
// Required env:
//   META_APP_SECRET                 - HMAC signing secret (PR 2 brief).
//   META_LEADS_WEBHOOK_VERIFY_TOKEN - token Meta sends back in GET handshake.
//   META_PAGE_ACCESS_TOKEN          - long-lived Page Access Token for Graph API.
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY       (falls back to SUPABASE_SERVICE_KEY).

import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { geocodePostcode, geocodeColumns } from "../../lib/postcodes.js";

export const config = { api: { bodyParser: false } };

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const REF_LENGTH = 8;
const REF_MAX_ATTEMPTS = 5;
const GRAPH_API_VERSION = "v19.0";

const VENUE_TYPE_MAP = {
  retail: "retail",
  office: "office",
  hospitality: "hospitality",
  "shopping centre": "shopping_centre",
  "shopping center": "shopping_centre",
  gym: "gym",
  "transport hub": "transport_hub",
  education: "education",
  other: "other",
};

const FIELD_KEYS = {
  fullName: ["full_name", "name", "your_name"],
  whatsappNumber: [
    "whatsapp_number",
    "whatsapp number",
    "whats_app_number",
    "phone_number",
    "phone",
  ],
  companyName: ["business_or_venue_name", "company_name", "business_name", "venue_name"],
  venueType: ["venue_type", "type_of_venue", "location_type"],
  city: ["location_or_city", "city", "location"],
  footTraffic: [
    "approximate_daily_foot_traffic_or_headcount",
    "daily_foot_traffic",
    "foot_traffic",
    "headcount",
  ],
  venuePostcode: ["venue_postcode", "postcode", "venue_post_code"],
};

export default async function handler(req, res) {
  if (req.method === "GET") return handleVerify(req, res);
  if (req.method === "POST") return handleWebhook(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}

function handleVerify(req, res) {
  const expected = process.env.META_LEADS_WEBHOOK_VERIFY_TOKEN;
  const mode = req.query?.["hub.mode"];
  const token = req.query?.["hub.verify_token"];
  const challenge = req.query?.["hub.challenge"];
  if (!expected) {
    console.error("META_LEADS_WEBHOOK_VERIFY_TOKEN not configured");
    return res.status(503).send("Service not configured");
  }
  if (mode === "subscribe" && token === expected) {
    return res.status(200).send(String(challenge ?? ""));
  }
  return res.status(403).send("Forbidden");
}

async function handleWebhook(req, res) {
  const appSecret = process.env.META_APP_SECRET;
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!appSecret || !pageToken || !supabaseUrl || !supabaseKey) {
    console.error("meta-lead-ads: missing env vars");
    return res.status(503).json({ error: "Service not configured" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error("meta-lead-ads: failed to read body", err);
    return res.status(400).json({ error: "Invalid body" });
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!verifySignature(rawBody, signature, appSecret)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // Acknowledge immediately so Meta does not retry; do remaining work in the
  // same invocation. Graph API + insert typically completes in ~500ms which
  // is well under the 5s budget, but the order matters in case the lambda
  // hits its deadline.
  res.status(200).json({ received: true });

  try {
    await processLeadgenEvents(payload, { pageToken, supabaseUrl, supabaseKey });
  } catch (err) {
    console.error("meta-lead-ads: processing failed", err);
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, header, secret) {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function processLeadgenEvents(payload, ctx) {
  if (payload?.object !== "page" || !Array.isArray(payload.entry)) return;

  for (const entry of payload.entry) {
    if (!Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (change.field !== "leadgen") continue;
      const v = change.value || {};
      if (!v.leadgen_id) continue;
      try {
        await ingestLead(v, ctx);
      } catch (err) {
        console.error(`meta-lead-ads: ingest failed for ${v.leadgen_id}`, err);
      }
    }
  }
}

async function ingestLead(value, ctx) {
  const { pageToken, supabaseUrl, supabaseKey } = ctx;
  const leadgenId = value.leadgen_id;

  const fields = await fetchLeadFields(leadgenId, pageToken);
  if (!fields) return;

  const sb = createClient(supabaseUrl, supabaseKey);

  // De-dupe on leadgen_id stored in utm_content fallback? Avoid double-insert
  // on Meta retries by checking we have not already inserted this lead.
  const { data: existing } = await sb
    .from("starbot_leads")
    .select("id")
    .eq("source", `meta_lead_ads:${leadgenId}`)
    .limit(1)
    .maybeSingle();
  if (existing) return;

  const row = await buildRow({ leadgenId, value, fields, sb });

  const { error } = await sb.from("starbot_leads").insert(row);
  if (error) {
    console.error("meta-lead-ads: insert failed", error.message);
    throw error;
  }
}

async function fetchLeadFields(leadgenId, pageToken) {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(leadgenId)}` +
    `?access_token=${encodeURIComponent(pageToken)}&fields=field_data,created_time,ad_id,adset_id,campaign_id,form_id`;
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    console.error(`meta-lead-ads: Graph API ${r.status} for ${leadgenId}: ${text}`);
    return null;
  }
  return r.json();
}

async function buildRow({ leadgenId, value, fields, sb }) {
  const fieldMap = indexFieldData(fields?.field_data);

  const fullName = pickField(fieldMap, FIELD_KEYS.fullName);
  const [firstName, ...rest] = (fullName || "").trim().split(/\s+/);
  const lastName = rest.join(" ") || null;

  const rawPhone = pickField(fieldMap, FIELD_KEYS.whatsappNumber);
  const e164 = normalisePhone(rawPhone);

  const venueLabel = pickField(fieldMap, FIELD_KEYS.venueType);
  const venueType = venueLabel ? VENUE_TYPE_MAP[venueLabel.trim().toLowerCase()] || null : null;

  const company = pickField(fieldMap, FIELD_KEYS.companyName);
  const city = pickField(fieldMap, FIELD_KEYS.city);
  const footTraffic = pickField(fieldMap, FIELD_KEYS.footTraffic);
  const rawPostcode = pickField(fieldMap, FIELD_KEYS.venuePostcode);

  // Geocode in-line. The helper handles timeout (4s) and maps every error
  // path onto a non-throwing result, so lead insertion is never blocked
  // by a postcodes.io blip — at worst we fall through to venue_geocode_status
  // = 'pending' and the lead surfaces in the manual-backfill side panel.
  const geocode = rawPostcode
    ? await geocodePostcode(rawPostcode)
    : { status: "no_postcode" };
  if (geocode.status === "pending") {
    console.error(
      `meta-lead-ads: postcode geocode pending for leadgen ${leadgenId}: ${geocode.error}`
    );
  }
  const geocodePatch = geocodeColumns(geocode);

  const refCode = await reserveRefCode(sb);

  const messageParts = [];
  if (city) messageParts.push(`Location/city: ${city}`);
  if (footTraffic) messageParts.push(`Approx daily foot traffic: ${footTraffic}`);
  const message = messageParts.length ? messageParts.join("\n") : null;

  const nowIso = new Date().toISOString();

  return {
    name: fullName || null,
    first_name: firstName || null,
    last_name: lastName,
    company: company || null,
    role: null,
    email: null,
    phone: rawPhone || null,
    phone_e164: e164,
    message,
    source: `meta_lead_ads:${leadgenId}`,
    utm_source: value.utm_source || null,
    utm_medium: value.utm_medium || null,
    utm_campaign: value.utm_campaign || null,
    utm_content: value.utm_content || null,
    venue_type: venueType,
    location_type: venueLabel || null,
    lead_ref_code: refCode,
    match_state: "form_only",
    archive_status: "active",
    status: "new",
    stage_entered_at: nowIso,
    last_activity_at: nowIso,
    ...geocodePatch,
  };
}

function indexFieldData(fieldData) {
  const map = new Map();
  if (!Array.isArray(fieldData)) return map;
  for (const f of fieldData) {
    if (!f || typeof f.name !== "string") continue;
    const key = f.name.trim().toLowerCase().replace(/\s+/g, "_");
    const value = Array.isArray(f.values) ? f.values[0] : f.values;
    map.set(key, value != null ? String(value) : null);
  }
  return map;
}

function pickField(map, candidates) {
  for (const c of candidates) {
    const key = c.toLowerCase().replace(/\s+/g, "_");
    if (map.has(key) && map.get(key)) return map.get(key);
  }
  return null;
}

function normalisePhone(raw) {
  if (!raw) return null;
  try {
    const p = parsePhoneNumberFromString(String(raw).trim(), "GB");
    if (p && p.isValid()) return p.number;
  } catch {
    // fall through
  }
  return null;
}

function generateRefCode() {
  const bytes = randomBytes(REF_LENGTH);
  let out = "";
  for (let i = 0; i < REF_LENGTH; i++) {
    out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return out;
}

// Try generating a unique lead_ref_code. Retries up to REF_MAX_ATTEMPTS
// times on collision, then throws. `genFn` is injectable for tests.
async function reserveRefCode(sb, genFn = generateRefCode) {
  for (let attempt = 1; attempt <= REF_MAX_ATTEMPTS; attempt++) {
    const candidate = genFn();
    const { data, error } = await sb
      .from("starbot_leads")
      .select("id")
      .eq("lead_ref_code", candidate)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("meta-lead-ads: ref-code lookup failed", error.message);
      throw error;
    }
    if (!data) return candidate;
  }
  throw new Error(`meta-lead-ads: ref-code collision after ${REF_MAX_ATTEMPTS} attempts`);
}

export const __test__ = {
  verifySignature,
  normalisePhone,
  generateRefCode,
  indexFieldData,
  pickField,
  reserveRefCode,
  VENUE_TYPE_MAP,
  REF_MAX_ATTEMPTS,
};
