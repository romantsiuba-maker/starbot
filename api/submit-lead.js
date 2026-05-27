import { createHash } from "crypto";
import { pushToZoho } from "../lib/zoho-client.js";

const META_PIXEL_ID = "831360616646272";
const TIKTOK_EVENTS_API_URL =
  "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const EDGE_FUNCTION_URL =
  "https://lxowggiqhuvwhzbktlsi.supabase.co/functions/v1/starbot-lead-notify";

function sha256(value) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function digitsOnly(phone) {
  return phone.replace(/[^\d]/g, "");
}

function sendCapiEvent({
  eventId,
  email,
  firstName,
  lastName,
  phone,
  clientIp,
  clientUserAgent,
  fbp,
  fbc,
  sourceUrl,
}) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) {
    console.warn("META_CAPI_ACCESS_TOKEN not set, skipping CAPI event");
    return;
  }

  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (firstName) userData.fn = [sha256(firstName)];
  if (lastName) userData.ln = [sha256(lastName)];
  if (phone) {
    const digits = digitsOnly(phone);
    if (digits.length >= 7) userData.ph = [sha256(digits)];
  }
  if (clientIp) userData.client_ip_address = clientIp;
  if (clientUserAgent) userData.client_user_agent = clientUserAgent;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (email) userData.external_id = [sha256(email)];

  const payload = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: sourceUrl || "https://partner.starbot.co.uk",
        action_source: "website",
        user_data: userData,
      },
    ],
  };

  fetch(
    `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  )
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`Meta CAPI Lead failed (${res.status}):`, text);
      } else {
        console.log("Meta CAPI Lead sent successfully");
      }
    })
    .catch((err) => console.error("Meta CAPI Lead error:", err));
}

function sendTikTokEvent({
  eventId,
  email,
  firstName,
  lastName,
  phone,
  clientIp,
  clientUserAgent,
  sourceUrl,
}) {
  const pixelId = process.env.TIKTOK_PIXEL_ID;
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!pixelId || !token) {
    console.warn(
      "TIKTOK_PIXEL_ID or TIKTOK_ACCESS_TOKEN not set, skipping TikTok event",
    );
    return;
  }

  const user = {};
  if (email) user.email = sha256(email);
  if (firstName) user.first_name = sha256(firstName);
  if (lastName) user.last_name = sha256(lastName);
  if (phone) {
    const digits = digitsOnly(phone);
    if (digits.length >= 7) user.phone = sha256(digits);
  }
  if (clientIp) user.ip = clientIp;
  if (clientUserAgent) user.user_agent = clientUserAgent;

  const payload = {
    event_source: "web",
    event_source_id: pixelId,
    data: [
      {
        event: "SubmitForm",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        user,
        page: { url: sourceUrl || "https://partner.starbot.co.uk" },
      },
    ],
  };

  fetch(TIKTOK_EVENTS_API_URL, {
    method: "POST",
    headers: {
      "Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`TikTok Events API failed (${res.status}):`, text);
      } else {
        console.log("TikTok Events API SubmitForm sent successfully");
      }
    })
    .catch((err) => console.error("TikTok Events API error:", err));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;
    const {
      first_name,
      last_name,
      company,
      role,
      email,
      phone,
      message,
      website,
      source,
      location_type,
      coffee_timeline,
      london_zone,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      source_url,
      venue_postcode,
      lead_source,
      lead_ref_code,
    } = body;

    // Basic validation
    if (!first_name || !first_name.trim()) {
      return res.status(400).json({ error: "First name is required" });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: "Phone is required" });
    }

    // Generate event_id for dedup
    const eventId = crypto.randomUUID();

    // Extract client info from headers
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || undefined;
    const clientUserAgent = req.headers["user-agent"] || undefined;

    const trimmedFirstName = first_name.trim();
    const trimmedLastName = last_name?.trim() || undefined;
    const trimmedEmail = email?.trim() || undefined;
    const trimmedPhone = phone?.trim() || undefined;
    const trimmedPostcode = venue_postcode?.trim() || undefined;
    const trimmedLeadSource = lead_source?.trim() || undefined;
    const trimmedLeadRefCode = lead_ref_code?.trim() || undefined;

    // Fire Meta CAPI event (fire-and-forget; no-ops if META_CAPI_ACCESS_TOKEN unset)
    sendCapiEvent({
      eventId,
      email: trimmedEmail,
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      phone: trimmedPhone,
      clientIp,
      clientUserAgent,
      sourceUrl: source_url || undefined,
    });

    // Fire TikTok Events API event (fire-and-forget)
    sendTikTokEvent({
      eventId,
      email: trimmedEmail,
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      phone: trimmedPhone,
      clientIp,
      clientUserAgent,
      sourceUrl: source_url || undefined,
    });

    // Push to Zoho CRM (fire-and-forget, runs in parallel with Supabase save)
    pushToZoho({
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      email: trimmedEmail,
      phone: trimmedPhone,
      postcode: trimmedPostcode,
      company: company?.trim() || undefined,
      role: role?.trim() || undefined,
      message: message?.trim() || undefined,
      leadSource: trimmedLeadSource,
      leadRefCode: trimmedLeadRefCode,
      locationType: location_type || undefined,
      coffeeTimeline: coffee_timeline || undefined,
      londonZone: london_zone || undefined,
      utmSource: utm_source || undefined,
      utmMedium: utm_medium || undefined,
      utmCampaign: utm_campaign || undefined,
      utmContent: utm_content || undefined,
    });

    // Forward to Supabase edge function (existing business logic)
    const combinedName = trimmedLastName
      ? `${trimmedFirstName} ${trimmedLastName}`
      : trimmedFirstName;
    // /quiz collects postcode; the existing landing form does not. We
    // forward venue_postcode + lead_ref_code to the edge function and
    // also append them to message so an operator can pull the postcode
    // from the lead card if the edge function ignores the new fields.
    // Geocoding happens server-side on the v2 side per Phase 3e flow.
    const messageWithPaperTrail = (() => {
      const base = message?.trim() || "";
      const annotations = [];
      if (trimmedPostcode) annotations.push(`Postcode: ${trimmedPostcode}`);
      if (trimmedLeadRefCode) annotations.push(`Ref: ${trimmedLeadRefCode}`);
      if (annotations.length === 0) return base || null;
      return [base, annotations.join(" · ")].filter(Boolean).join("\n\n");
    })();
    const edgePayload = {
      name: combinedName,
      first_name: trimmedFirstName,
      last_name: trimmedLastName || null,
      company: company || null,
      role: role || null,
      email: trimmedEmail || null,
      phone: trimmedPhone || null,
      message: messageWithPaperTrail,
      website: website || "",
      source: source || "landing_page",
      location_type: location_type || null,
      coffee_timeline: coffee_timeline || null,
      london_zone: london_zone || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      venue_postcode: trimmedPostcode || null,
      lead_ref_code: trimmedLeadRefCode || null,
    };

    const edgeRes = await fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(edgePayload),
    });

    if (!edgeRes.ok) {
      const errorData = await edgeRes.json().catch(() => ({}));
      return res
        .status(edgeRes.status)
        .json({ error: errorData.error || "Failed to save lead" });
    }

    return res.status(200).json({ success: true, event_id: eventId });
  } catch (err) {
    console.error("submit-lead error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
