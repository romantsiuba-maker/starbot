// Vercel serverless function: server-renders the /thanks page that Meta
// redirects leads to after form submission. Hands off to WhatsApp with a
// pre-filled message that contains the lead_ref_code when available so
// the PR 4 inbound webhook can match the message to a lead.
//
// Env:
//   STARBOT_WHATSAPP_NUMBER   - public WhatsApp Business number (with or
//                                without leading +). wa.me wants raw digits.
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY (falls back to SUPABASE_SERVICE_KEY).

import { createClient } from "@supabase/supabase-js";

const REF_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const MAX_FIELD = 80; // pre-fill text is short; truncate runaway inputs

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const number = stripWhatsAppNumber(process.env.STARBOT_WHATSAPP_NUMBER);
  if (!number) {
    console.error("/thanks: STARBOT_WHATSAPP_NUMBER not configured");
    return sendHtml(res, 503, renderError("Service not configured"));
  }

  const refRaw = firstString(req.query.ref);
  const ref = refRaw && REF_RE.test(refRaw.toUpperCase()) ? refRaw.toUpperCase() : null;
  let name = trimField(firstString(req.query.name));
  let venue = trimField(firstString(req.query.venue));

  // Fallback: if ref is valid but name/venue are missing, look the lead up.
  if (ref && (!name || !venue)) {
    const fetched = await fetchLeadContext(ref);
    if (fetched) {
      if (!name) name = fetched.name;
      if (!venue) venue = fetched.venue;
    }
  }

  const message = buildMessage({ name, venue, ref });
  const waHref = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;

  return sendHtml(res, 200, renderPage({ waHref, message, ref, name, venue }));
}

function sendHtml(res, status, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Don't cache: the page reflects per-visit query params + fresh lead lookups.
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).send(body);
}

function firstString(v) {
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

function trimField(v) {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > MAX_FIELD ? t.slice(0, MAX_FIELD) : t;
}

function stripWhatsAppNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  return digits || null;
}

async function fetchLeadContext(ref) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const sb = createClient(url, key);
    const { data, error } = await sb
      .from("starbot_leads")
      .select("first_name, company")
      .eq("lead_ref_code", ref)
      .maybeSingle();
    if (error || !data) return null;
    return {
      name: trimField(data.first_name),
      venue: trimField(data.company),
    };
  } catch (err) {
    console.error("/thanks: lead lookup failed", err);
    return null;
  }
}

export function buildMessage({ name, venue, ref }) {
  // The brief defines four branches keyed off ref. Without ref, the message
  // is generic since the inbound webhook can't disambiguate by message text.
  if (!ref) return "Hi, I just submitted the Starbot form";
  if (name && venue) return `Hi, I'm ${name} from ${venue}. I just submitted the Starbot form (ref: ${ref})`;
  if (name) return `Hi, I'm ${name}. I just submitted the Starbot form (ref: ${ref})`;
  return `Hi, I just submitted the Starbot form (ref: ${ref})`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderError(text) {
  return `<!doctype html><meta charset="utf-8"><title>Starbot</title><body style="font-family:sans-serif;padding:24px">${escapeHtml(text)}</body>`;
}

function renderPage({ waHref, message, ref, name, venue }) {
  const safeHref = escapeHtml(waHref);
  const safeMessage = escapeHtml(message);
  const refPill = ref ? `<div class="ref-pill">REF&nbsp;<span>${escapeHtml(ref)}</span></div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex" />
  <title>Thanks — Starbot</title>
  <link rel="icon" href="https://cdn.prod.website-files.com/66e09bcd111e1de7c4153094/66e2ed435a1621ce1e7792db_favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-page: #0a0e14;
      --bg-surface: rgba(21, 21, 21, 0.75);
      --text-primary: #eeeeee;
      --text-secondary: #888888;
      --accent: #2db6b7;
      --accent-hover: #25a0a1;
      --radius: 12px;
      --glass-border: rgba(255, 255, 255, 0.06);
      --glass-blur: 16px;
      --font-body: "DM Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    }
    html, body {
      min-height: 100%;
      background:
        radial-gradient(circle at 20% 0%, rgba(45,182,183,0.10), transparent 50%),
        radial-gradient(circle at 80% 100%, rgba(45,182,183,0.06), transparent 50%),
        var(--bg-page);
      color: var(--text-primary);
      font-family: var(--font-body);
      -webkit-font-smoothing: antialiased;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      min-height: 100vh;
      min-height: 100dvh;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: var(--bg-surface);
      backdrop-filter: blur(var(--glass-blur));
      -webkit-backdrop-filter: blur(var(--glass-blur));
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      padding: 32px 24px 28px;
      text-align: center;
    }
    h1 {
      font-size: 22px;
      line-height: 1.3;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin-bottom: 24px;
    }
    .cta {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 16px 18px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      font: 600 16px/1 var(--font-body);
      text-decoration: none;
      cursor: pointer;
      transition: background 120ms ease;
      -webkit-tap-highlight-color: transparent;
    }
    .cta:hover, .cta:focus-visible {
      background: var(--accent-hover);
      outline: none;
    }
    .cta:active { transform: translateY(1px); }
    .cta svg { width: 20px; height: 20px; flex-shrink: 0; }
    .subtext {
      margin-top: 16px;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .ref-pill {
      display: inline-flex;
      align-items: center;
      margin-top: 18px;
      padding: 6px 10px;
      background: rgba(45,182,183,0.10);
      border: 1px solid rgba(45,182,183,0.30);
      border-radius: 999px;
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--accent);
      font-weight: 500;
    }
    .ref-pill span {
      margin-left: 6px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--text-primary);
    }
    @media (min-width: 480px) {
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <main class="card" role="main">
    <h1>Thanks, we got your details</h1>
    <a class="cta" href="${safeHref}" rel="noopener">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
        <path d="M19.05 4.91A10 10 0 0 0 12 2a10 10 0 0 0-8.6 15.05L2 22l5.06-1.33A10 10 0 0 0 12 22a10 10 0 0 0 7.05-17.09ZM12 20.13a8.13 8.13 0 0 1-4.14-1.13l-.3-.18-3 .79.8-2.93-.19-.31a8.13 8.13 0 1 1 6.83 3.76Zm4.46-6.1c-.24-.12-1.44-.71-1.66-.79s-.39-.12-.55.12-.63.79-.78.95-.29.18-.53.06a6.66 6.66 0 0 1-1.97-1.22 7.45 7.45 0 0 1-1.36-1.7c-.14-.24 0-.36.1-.48s.24-.29.36-.43a1.68 1.68 0 0 0 .24-.41.45.45 0 0 0 0-.43c-.06-.12-.55-1.33-.76-1.83s-.41-.41-.55-.42-.31 0-.47 0a.91.91 0 0 0-.66.31 2.76 2.76 0 0 0-.87 2.06 4.8 4.8 0 0 0 1.01 2.56 11 11 0 0 0 4.23 3.74c.59.26 1.05.41 1.41.52a3.41 3.41 0 0 0 1.56.1 2.55 2.55 0 0 0 1.67-1.18 2.07 2.07 0 0 0 .14-1.18c-.06-.1-.22-.16-.46-.28Z"/>
      </svg>
      Message us on WhatsApp
    </a>
    <p class="subtext">We'll reply within a few hours</p>
    ${refPill}
    <noscript><p class="subtext" style="margin-top:12px">Pre-filled message: ${safeMessage}</p></noscript>
  </main>
</body>
</html>`;
}
