# Starbot — Business Context

---

## The Business

**Starbot** — premium robot barista kiosks for the UK market. Fully automated, zero staff, barista-quality coffee. The business model is franchise partnerships: Starbot installs and manages the kiosk, the location partner provides the space.

Target partners: office buildings, co-working spaces, corporate HQs, residential developments, universities, hospitals — anywhere with steady foot traffic that would benefit from premium coffee without staffing overhead.

---

## The Website

**partner.starbot.co.uk** — B2B partner acquisition landing page.

Traffic source: Meta ads (Facebook/Instagram) targeting UK property managers, facilities managers, and building owners. Ads drive to the landing page, which captures leads via a consultation form.

The form collects: first name, last name, company/building, role, email, phone (optional), message (optional). UTM parameters and Facebook cookies are captured for ad attribution.

---

## The Dashboard

**partner.starbot.co.uk/dashboard** — manual Kanban CRM for managing inbound partner leads.

This is not a SaaS product. It's an internal tool operated by one person (Roman) to track and close partnership deals. No AI, no automation — just a clean pipeline view with communication logging.

### Pipeline Stages

| Stage       | Meaning                                          |
| ----------- | ------------------------------------------------ |
| New         | Lead submitted form, no contact yet              |
| Contacted   | First email or call made                         |
| Interested  | Lead responded positively, exploring partnership |
| Negotiating | Terms being discussed, site visit, paperwork     |
| Won         | Partnership signed                               |
| Lost        | Lead declined or went cold                       |

### What the Manager Does

1. Lead arrives (form submission from Meta ads)
2. Review in dashboard — check company, role, message
3. Send first email or make a phone call
4. Log all interactions in the conversation timeline (notes, calls, meetings, emails)
5. Advance through pipeline stages as the deal progresses
6. Close as Won (partnership signed) or Lost (declined/cold)

### Communication Channels

- **Email:** Sent from dashboard via Resend (`hello@starbot.co.uk`). Replies arrive via inbound webhook and appear in the conversation log automatically.
- **Phone:** Calls are logged manually in the conversation log with the "Call" tag.
- **Meetings:** Site visits and video calls are logged with the "Meeting" tag.

---

## Revenue Model

Starbot handles:

- Free installation of the robot barista kiosk
- All maintenance, restocking, and technical support
- Premium coffee supply (partners: Minor Figures, Shott Beverages)
- 50+ drink menu, fully customisable

The location partner provides the space. Revenue is shared or the partner pays a management fee — terms negotiated per deal.

---

## Key Numbers

- 50+ drinks available per kiosk
- Zero staff required from the partner
- Free installation, zero risk for the partner
- Fully managed by Starbot

---

## Ad Tracking

- **Meta Pixel:** `831360616646272` — fires PageView on load, Lead on form submit
- **Meta CAPI:** Server-side conversion tracking via `/api/submit-lead` with SHA256 hashed PII, event_id deduplication between client and server
- **Google Tag Manager:** `GTM-KLD4PZGM` — container for additional tracking
- **UTM parameters:** Captured from URL and stored on the lead record
- **Facebook cookies:** `_fbp` and `_fbc` passed to CAPI for better matching
