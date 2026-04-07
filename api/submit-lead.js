import { createHash } from "crypto";

const META_PIXEL_ID = "831360616646272";
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
        event_source_url: sourceUrl || "https://partner.starbot.coffee",
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
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      fbp,
      fbc,
      source_url,
    } = body;

    // Basic validation
    if (!first_name || !first_name.trim()) {
      return res.status(400).json({ error: "First name is required" });
    }
    if (!last_name || !last_name.trim()) {
      return res.status(400).json({ error: "Last name is required" });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Generate event_id for dedup
    const eventId = crypto.randomUUID();

    // Extract client info from headers
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || undefined;
    const clientUserAgent = req.headers["user-agent"] || undefined;

    // Fire Meta CAPI event (fire-and-forget)
    sendCapiEvent({
      eventId,
      email: email.trim(),
      firstName: first_name.trim(),
      lastName: last_name.trim(),
      phone: phone?.trim() || undefined,
      clientIp,
      clientUserAgent,
      fbp: typeof fbp === "string" ? fbp.trim() || undefined : undefined,
      fbc: typeof fbc === "string" ? fbc.trim() || undefined : undefined,
      sourceUrl: source_url || undefined,
    });

    // Forward to Supabase edge function (existing business logic)
    const combinedName = `${first_name.trim()} ${last_name.trim()}`;
    const edgePayload = {
      name: combinedName,
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      company: company || null,
      role: role || null,
      email: email.trim(),
      phone: phone?.trim() || null,
      message: message?.trim() || null,
      website: website || "",
      source: source || "landing_page",
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
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
