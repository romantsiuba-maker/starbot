# Starbot — Architecture Reference

Read this before making any changes. This is the source of truth for how the system is technically structured.

---

## What This Is

A B2B partner acquisition site for Starbot (robot barista franchise). Two parts:

1. **Landing page** (`partner.starbot.co.uk`) — static HTML, single-file. London-positioned commission narrative. Hero with embedded 3-question qualification quiz (location type, timeline, London zone); after Q3 the lead form appears in the same hero slot (first_name + phone required, email optional) + social proof + how-it-works + photo gallery + comparison block + footer. Captures leads from TikTok ads
2. **Dashboard** (`partner.starbot.co.uk/dashboard`) — Kanban CRM for managing leads manually

No frameworks. No build step. No AI agents.

---

## Stack

- Static HTML + vanilla JS (no React, no Next.js)
- Vercel serverless functions (Node.js) for API routes
- Supabase Postgres (project: `lxowggiqhuvwhzbktlsi`)
- Resend for outbound email + inbound webhook
- Zoho CRM (lead sync via OAuth refresh-token flow)
- TikTok Pixel + TikTok Events API for ad tracking (Meta CAPI server-side kept but disabled via env)
- Google Tag Manager (`GTM-KLD4PZGM`)
- SortableJS (CDN) for drag-and-drop
- Supabase JS v2 (CDN) for frontend auth + queries
- Leaflet 1.9.4 + Leaflet.markercluster 1.5.3 (CDN) for the map view (PR 48)
- postcodes.io for UK postcode → lat/lng geocoding (no key)

---

## File Structure

```
starbot/
├── index.html              # Landing page (partner.starbot.co.uk) — v2, single-file
├── images/                 # Hero + gallery photos (6 starbot-*.jpg)
├── dashboard/
│   └── index.html          # Kanban CRM dashboard (2100+ lines, all-in-one)
├── api/
│   ├── submit-lead.js      # Form submission → Supabase edge function + Zoho + TikTok Events API + Meta CAPI (deprecated)
│   ├── send-reply.js       # Outbound email via Resend + conversation log update
│   └── inbound-email.js    # Resend inbound webhook → match lead → append to log
├── vercel.json             # Rewrites, CSP headers, security headers
├── package.json            # Dependencies for API routes (@supabase/supabase-js)
├── package-lock.json       # Lock file
├── .gitignore              # node_modules, .env, .vercel
└── README.md               # One-liner
```

---

## Database Schema (Supabase)

**Project:** `lxowggiqhuvwhzbktlsi`
**Table:** `starbot_leads` (RLS enabled)

| Column           | Type        | Default         | Notes                                     |
| ---------------- | ----------- | --------------- | ----------------------------------------- |
| id               | uuid        | gen_random_uuid | Primary key                               |
| name             | text        |                 | Combined "first last"                     |
| first_name       | text        |                 | From form                                 |
| last_name        | text        |                 | From form                                 |
| company          | text        |                 | Company / building name                   |
| role             | text        |                 | Contact's role                            |
| email            | text        |                 | Required                                  |
| phone            | text        |                 | Optional                                  |
| message          | text        |                 | Form message field                        |
| source           | text        |                 | e.g. "landing_page"                       |
| utm_source       | text        |                 | Meta ads tracking                         |
| utm_medium       | text        |                 | Meta ads tracking                         |
| utm_campaign     | text        |                 | Meta ads tracking                         |
| utm_content      | text        |                 | Meta ads tracking                         |
| location_type    | text        |                 | Quiz Q1: venue type                       |
| coffee_timeline  | text        |                 | Quiz Q2: timeline to launch               |
| london_zone      | text        |                 | Quiz Q3: London geography                 |
| status           | text        | 'new'           | Pipeline stage                            |
| notes            | text        |                 | Private notes (auto-save on blur)         |
| conversation_log | jsonb       | '[]'            | Array of {date, from, text, tag, subject} |
| created_at       | timestamptz | now()           | Row creation                              |
| updated_at       | timestamptz | now()           | Auto-updated via trigger                  |

**Pipeline stages (status values):** `new` → `contacted` → `interested` → `negotiating` → `won` → `lost`

**Conversation log entry shape:**

```json
{
  "date": "2026-04-09T10:00:00.000Z",
  "from": "roman" | "lead" | "system",
  "text": "message content",
  "tag": "Note" | "Call" | "Meeting" | "Email" | "Reply" | "Inquiry",
  "subject": "Re: Starbot Partnership"
}
```

**RLS policies:**

- `Dashboard read` — authenticated users can SELECT all rows
- `Dashboard update` — authenticated users can UPDATE all rows
- INSERT — handled by Supabase edge function (service_role), not by dashboard

**Trigger:** `starbot_leads_updated_at` — sets `updated_at = now()` on every UPDATE.

---

## Auth

Supabase built-in auth with `signInWithPassword`. Dashboard shows login screen first. No signup flow — users are created manually in Supabase Auth dashboard.

- Frontend uses **anon key** (published in dashboard HTML, safe with RLS)
- API routes use **service key** (env var, never in frontend)

---

## API Routes

### POST /api/submit-lead

**Purpose:** Landing page form submission handler.
**Called by:** Landing page `index.html` form JS.
**Does:**

1. Validates required fields (`first_name`, `phone`). `last_name` and `email` are optional — frontend may send empty/null
2. Fires TikTok Events API "SubmitForm" event (fire-and-forget) with hashed PII. Also fires Meta CAPI "Lead" event if `META_CAPI_ACCESS_TOKEN` is still set (deprecated path)
3. Forwards lead data to Supabase edge function (`starbot-lead-notify`), including the 3 quiz answers (`location_type`, `coffee_timeline`, `london_zone`) which the edge function persists to the matching columns
4. Returns `{ success: true, event_id }` for client-side pixel dedup
5. Pushes lead to Zoho CRM (fire-and-forget) via OAuth refresh-token flow. `Last_Name` defaults to `"-"` if not supplied (Zoho requires the field). `Email` is omitted from the payload when not supplied. Quiz answers are included in the Zoho lead Description (no separate Zoho custom fields)

**Env vars:** `TIKTOK_PIXEL_ID`, `TIKTOK_ACCESS_TOKEN`, `META_CAPI_ACCESS_TOKEN` (deprecated), `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL`

### POST /api/send-reply

**Purpose:** Send outbound email to a lead via Resend.
**Called by:** Dashboard "Send via Email" button.
**Does:**

1. Sends HTML email via Resend API (from: `Roman <hello@starbot.co.uk>`, reply-to: `leads@reply.starbot.co.uk`)
2. Appends entry to lead's `conversation_log` in Supabase

**Env vars:** `RESEND_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
**Request body:** `{ leadId, to, subject, body }`

### POST /api/inbound-email

**Purpose:** Resend inbound webhook handler — captures lead replies.
**Called by:** Resend webhook when email arrives at `*@reply.starbot.co.uk`.
**Does:**

1. Extracts `email_id` from webhook payload
2. Fetches full email content from Resend API
3. Matches sender to a lead by email address
4. Appends inbound message to lead's `conversation_log`

**Env vars:** `RESEND_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

---

## Email Infrastructure

- **Outbound:** Resend, from `hello@starbot.co.uk`
- **Reply-to:** `leads@reply.starbot.co.uk`
- **Inbound:** Resend receiving on `reply.starbot.co.uk` → webhook → `/api/inbound-email`
- **Domain:** `starbot.co.uk` must be verified in Resend for sending

---

## Dashboard Features

All in `dashboard/index.html` (single file):

- **Login:** Supabase signInWithPassword
- **Kanban board:** 6 columns (new → contacted → interested → negotiating → won → lost), drag-and-drop via SortableJS
- **Lead cards:** Company, contact name, role, relative time, status pill
- **Detail modal:** Company header, pills (status + UTM), contact row (email + phone), Qualification panel (location type, coffee timeline, London zone — shown when any quiz answer present, hidden for legacy pre-quiz leads), conversation thread, compose area, notes, UTM data (collapsed)
- **Conversation log:** Timeline layout (date + sender + tag in one row, body indented). Auto-prepends form submission as first entry (display-only, no DB write).
- **Compose:** Log type selector (Note/Call/Meeting) + Log button, Send via Email button (reveals subject field on first click, sends on second)
- **Action bar:** Date, Delete, Email shortcut, Stage advance, Close
- **Search + filter:** By company/name, by status
- **Mobile responsive:** Columns stack, modal full-width

---

## Vercel Configuration

**Project:** `starbot` (ID: `prj_caPjmiG7M0ycgqIsMUfb2dnO1SUr`)
**Org:** `team_tyYrLiDCRl6pGWlNUKijcehD`
**Domain:** `partner.starbot.co.uk`

**Rewrites:**

- `/dashboard` → `/dashboard/index.html`
- `/dashboard/` → `/dashboard/index.html`

**Security headers** (all routes):

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- Content-Security-Policy with allowances for: TikTok (Pixel + Events API), Facebook (legacy Meta Pixel — kept for now, inert), Google Tag Manager, Supabase, cdn.jsdelivr.net (CDN libs), Google Fonts

**Deployment:** GitHub auto-deploy on `main` branch. Never run `vercel --prod` from a feature branch.

---

## Environment Variables

| Variable                 | Used by                         | Purpose                                        |
| ------------------------ | ------------------------------- | ---------------------------------------------- |
| `TIKTOK_PIXEL_ID`        | submit-lead.js                  | TikTok Pixel ID (event_source_id)              |
| `TIKTOK_ACCESS_TOKEN`    | submit-lead.js                  | TikTok Events API access token                 |
| `META_CAPI_ACCESS_TOKEN` | submit-lead.js                  | Meta Conversion API token (deprecated — unset to disable) |
| `RESEND_API_KEY`         | send-reply.js, inbound-email.js | Resend email API                               |
| `SUPABASE_URL`           | send-reply.js, inbound-email.js | Supabase project URL                           |
| `SUPABASE_SERVICE_KEY`   | send-reply.js, inbound-email.js | Supabase service role key                      |
| `ZOHO_CLIENT_ID`         | submit-lead.js                  | Zoho OAuth client ID                           |
| `ZOHO_CLIENT_SECRET`     | submit-lead.js                  | Zoho OAuth client secret                       |
| `ZOHO_REFRESH_TOKEN`     | submit-lead.js                  | Zoho OAuth refresh token (long-lived)          |
| `ZOHO_ACCOUNTS_URL`      | submit-lead.js                  | Zoho accounts base URL (e.g. accounts.zoho.eu) |
| `ZOHO_API_URL`           | submit-lead.js                  | Zoho API base URL (e.g. www.zohoapis.eu)       |

The Supabase **anon key** is hardcoded in `dashboard/index.html` (safe — RLS enforced, read/update only for authenticated users).
