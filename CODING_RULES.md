# Starbot — Coding Rules

Read this before writing any code. Read ARCHITECTURE.md first for full system context.

---

## 1. Read Before You Write

Every session, before making changes:

1. Read ARCHITECTURE.md (what exists, how it's structured)
2. Read this file (how to write code)
3. Read the actual source files you're about to change

Never guess the cause of a bug. Read the code, verify step by step.

---

## 2. Single-File Dashboard

All dashboard code lives in `dashboard/index.html` — HTML, CSS, and JS in one file. Do not split it into separate files. Do not add a build step. Do not add npm scripts for the frontend.

CDN libraries only: Supabase JS, SortableJS. No other dependencies in the frontend.

---

## 3. API Routes

API routes are Vercel serverless functions in the `api/` directory. One file per endpoint.

- `submit-lead.js` — form submission (public)
- `send-reply.js` — outbound email (called from dashboard)
- `inbound-email.js` — Resend inbound webhook (called by Resend)

Each function validates input, calls external services, returns JSON. Keep them self-contained.

---

## 4. Supabase Keys

- **Frontend (dashboard/index.html):** Uses the **anon key**. RLS is enforced. Authenticated users can SELECT and UPDATE only.
- **API routes (api/\*.js):** Use the **service key** via `SUPABASE_SERVICE_KEY` env var. Never expose the service key in frontend code.

---

## 5. No AI Agents

This is a manual CRM. A human manager operates the dashboard — reads leads, logs calls, sends emails, advances pipeline stages. There are no AI agents, no automated replies, no LLM calls.

---

## 6. Testing Email

After any changes to `api/send-reply.js` or `api/inbound-email.js`, test the full email pipeline:

1. Send a test email from the dashboard
2. Reply to it from the recipient's inbox
3. Verify the reply appears in the lead's conversation log

---

## 7. Environment Variables

All secrets go in Vercel env vars, never hardcoded in source. Required vars are documented in ARCHITECTURE.md. Check that env vars exist before using them — return 503 if missing in production.

---

## 8. Deployment

- All changes go through: feature branch → PR → merge to main
- GitHub auto-deploy handles production
- Never run `vercel --prod` or `vercel --prod --force` from a feature branch
- Never push directly to main

---

## 9. Security

- Never expose Supabase service key, Resend API key, or Meta CAPI token in frontend code
- Never expose Zoho credentials (`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`) in frontend code
- The anon key in `dashboard/index.html` is safe because RLS is enforced
- All API routes validate input before processing
- Honeypot field (`website`) in landing page form catches bots
- CSP headers restrict script/connect sources

---

## 10. Naming Conventions

| Thing         | Convention       | Example                  |
| ------------- | ---------------- | ------------------------ |
| Files         | kebab-case       | `send-reply.js`          |
| Functions     | camelCase        | `updateComposeButtons()` |
| DB columns    | snake_case       | `conversation_log`       |
| CSS classes   | kebab-case       | `.convo-meta-row`        |
| CSS variables | --kebab-case     | `--bg-elevated`          |
| Env vars      | UPPER_SNAKE_CASE | `RESEND_API_KEY`         |

---

## 11. Conversation Log Entries

When saving to `conversation_log`, use this shape:

```json
{
  "date": "ISO 8601 timestamp",
  "from": "roman" | "lead" | "system",
  "text": "message content",
  "tag": "Note" | "Call" | "Meeting" | "Email" | "Reply" | "Inquiry",
  "subject": "optional subject line"
}
```

Tags and their meanings:

- **Inquiry** — auto-generated from form submission (display-only, not stored)
- **Note** — manual note logged by manager
- **Call** — phone call summary logged by manager
- **Meeting** — meeting notes logged by manager
- **Email** — outbound email sent via Resend
- **Reply** — inbound email received via webhook

---

## 12. Governance

- This file can only be updated with Roman's approval
- If a coding rule is impractical, flag it — don't silently ignore it
- ARCHITECTURE.md is the source of truth for system structure
- BUSINESS.md is the source of truth for what the business does
