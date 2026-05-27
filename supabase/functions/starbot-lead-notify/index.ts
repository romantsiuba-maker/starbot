import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = "re_WBEXk5eL_Lut4bku9HbnqDrx6n8aEUhLZ";
const SUPABASE_URL = "https://lxowggiqhuvwhzbktlsi.supabase.co";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NOTIFY_EMAIL = "hello@starbot.co.uk";
const LOGO_URL = "https://cdn.prod.website-files.com/66e09bcd111e1de7c4153094/66e2ed435a1621ce1e7792db_favicon.png";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "tempmail.com", "throwaway.email",
  "10minutemail.com", "trashmail.com", "fakeinbox.com", "sharklasers.com",
  "guerrillamailblock.com", "grr.la", "guerrillamail.info", "guerrillamail.net",
  "yopmail.com", "tempail.com", "dispostable.com", "maildrop.cc",
  "mailnesia.com", "temp-mail.org", "getairmail.com", "mohmal.com",
  "emailondeck.com", "33mail.com", "mailcatch.com", "mintemail.com",
  "nomail.xl.cx", "spaml.com", "uggsrock.com", "mailnull.com"
]);

const TLD_TYPOS: Record<string, string> = {
  ".con": ".com", ".cmo": ".com", ".ocm": ".com", ".vom": ".com", ".xom": ".com",
  ".cpm": ".com", ".cim": ".com", ".cm": ".com", ".comm": ".com",
  ".couk": ".co.uk", ".co.yk": ".co.uk", ".co.ik": ".co.uk", ".co.ul": ".co.uk",
  ".nte": ".net", ".ent": ".net", ".nett": ".net", ".ogr": ".org", ".orgg": ".org",
};

const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com", "gamil.com": "gmail.com", "gmal.com": "gmail.com",
  "gmaill.com": "gmail.com", "gnail.com": "gmail.com", "gmai.com": "gmail.com",
  "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmil.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "hotmaill.com": "hotmail.com", "hotmail.con": "hotmail.com",
  "outlok.com": "outlook.com", "outllook.com": "outlook.com", "outlook.con": "outlook.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com",
  "iclould.com": "icloud.com", "icoud.com": "icloud.com", "icloud.con": "icloud.com",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return DISPOSABLE_DOMAINS.has(domain);
}

function detectEmailTypo(email: string): string | null {
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1];
  if (!domain) return null;
  if (DOMAIN_TYPOS[domain]) {
    return lower.split("@")[0] + "@" + DOMAIN_TYPOS[domain];
  }
  for (const [typo, correction] of Object.entries(TLD_TYPOS)) {
    if (lower.endsWith(typo)) {
      return lower.slice(0, lower.length - typo.length) + correction;
    }
  }
  return null;
}

function isBusinessEmail(email: string): boolean {
  const freeProviders = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "mail.com", "protonmail.com", "zoho.com", "yandex.com", "mail.ru", "live.com"];
  const domain = email.split("@")[1]?.toLowerCase();
  return !freeProviders.includes(domain);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const {
      first_name, last_name, name: rawName,
      company, role, email, phone, message,
      source, utm_source, utm_medium, utm_campaign, utm_content,
      location_type, coffee_timeline, london_zone,
      website
    } = body;

    const firstName = first_name?.trim() || "";
    const lastName = last_name?.trim() || "";
    const cleanedEmail = email?.trim()?.toLowerCase() || "";
    const cleanedPhone = phone?.trim() || "";
    const name = (firstName && lastName)
      ? `${firstName} ${lastName}`
      : rawName?.trim() || firstName || "";

    if (website) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!firstName) {
      return new Response(JSON.stringify({ error: "Please tell us your first name" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!cleanedPhone) {
      return new Response(JSON.stringify({ error: "Phone number is required so we can call you" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (cleanedEmail) {
      if (!isValidEmail(cleanedEmail)) {
        return new Response(JSON.stringify({ error: "Please enter a valid email address" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const suggestion = detectEmailTypo(cleanedEmail);
      if (suggestion) {
        return new Response(JSON.stringify({
          error: `Did you mean ${suggestion}?`,
          suggestion: suggestion,
          type: "typo"
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (isDisposableEmail(cleanedEmail)) {
        return new Response(JSON.stringify({ error: "Please use your work email address" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Dedup by phone (24h window)
    try {
      const { data: existing } = await supabase
        .from("starbot_leads")
        .select("id")
        .eq("phone", cleanedPhone)
        .gte("created_at", twentyFourHoursAgo)
        .limit(1);
      if (existing && existing.length > 0) {
        return new Response(JSON.stringify({ error: "You have already submitted an enquiry. We will be in touch soon." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch (dedupErr) {
      console.error("Dedup check failed (non-fatal, continuing):", dedupErr);
    }

    const isBusiness = cleanedEmail ? isBusinessEmail(cleanedEmail) : false;

    // Insert lead - this is the source of truth
    const { error: dbError } = await supabase.from("starbot_leads").insert({
      name: name || firstName,
      first_name: firstName || null,
      last_name: lastName || null,
      company: company || null,
      role: role || null,
      email: cleanedEmail || null,
      phone: cleanedPhone,
      message: message || null,
      source: source || "landing_page",
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      location_type: location_type || null,
      coffee_timeline: coffee_timeline || null,
      london_zone: london_zone || null,
    });

    if (dbError) {
      console.error("DB insert error:", dbError);
      return new Response(JSON.stringify({ error: "Failed to save lead" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // From here: lead is saved. All downstream operations are fire-and-forget.
    // Wrap each in try/catch so a failure cannot affect the success response.

    const displayName = firstName || name || "there";
    const companyDisplay = company ? `at <strong>${company}</strong>` : "in your space";

    if (cleanedEmail) {
      try {
        const confirmationEmail = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: "Starbot <hello@starbot.co.uk>",
            to: [cleanedEmail],
            subject: "Thanks for your interest in Starbot",
            html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px; background: #ffffff;"><div style="text-align: center; margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid #eee;"><img src="${LOGO_URL}" alt="Starbot" width="44" height="44" style="display: block; margin: 0 auto 10px;"><span style="font-size: 18px; font-weight: 700; color: #0f1923; letter-spacing: 2px;">STARBOT</span></div><p style="font-size: 16px; color: #2a3544; line-height: 1.6; margin: 0 0 16px;">Hi ${displayName},</p><p style="font-size: 16px; color: #2a3544; line-height: 1.6; margin: 0 0 16px;">Thanks for your interest in bringing a robot barista ${companyDisplay}.</p><p style="font-size: 16px; color: #2a3544; line-height: 1.6; margin: 0 0 24px;">Our team will be in touch within <strong>24 hours</strong> to discuss how Starbot works for your space.</p><p style="font-size: 15px; color: #2a3544; line-height: 1.6; margin: 0;">Speak soon,</p><p style="font-size: 15px; color: #0f1923; font-weight: 600; margin: 4px 0 0;">The Starbot Team</p><div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; text-align: center;"><p style="font-size: 12px; color: #9ca3af; margin: 0;">London's First Robot Barista</p></div></div>`,
          }),
        });
        if (!confirmationEmail.ok) {
          console.error("Confirmation email error:", await confirmationEmail.text());
        }
      } catch (confirmErr) {
        console.error("Confirmation email throw (non-fatal):", confirmErr);
      }
    }

    try {
      const emailType = cleanedEmail ? (isBusiness ? "✅ Business email" : "⚠️ Personal email") : "";
      const emailRow = cleanedEmail ? `<tr><td style="padding: 10px 0; color: #6b7280;">Email</td><td style="padding: 10px 0;"><a href="mailto:${cleanedEmail}" style="color: #2DB6B7;">${cleanedEmail}</a> <span style="font-size: 11px;">${emailType}</span></td></tr>` : `<tr><td style="padding: 10px 0; color: #6b7280;">Email</td><td style="padding: 10px 0; color: #9ca3af; font-style: italic;">Not provided</td></tr>`;
      const companyRow = company ? `<tr><td style="padding: 10px 0; color: #6b7280;">Company</td><td style="padding: 10px 0;">${company}</td></tr>` : "";
      const roleRow = role ? `<tr><td style="padding: 10px 0; color: #6b7280;">Role</td><td style="padding: 10px 0;">${role}</td></tr>` : "";
      const messageRow = message ? `<tr><td style="padding: 10px 0; color: #6b7280;">Message</td><td style="padding: 10px 0;">${message}</td></tr>` : "";
      const qualRow = (location_type || coffee_timeline || london_zone) ? `<tr><td style="padding: 10px 0; color: #6b7280;">Qualification</td><td style="padding: 10px 0; font-size: 13px;">${location_type || "-"} &middot; ${coffee_timeline || "-"} &middot; ${london_zone || "-"}</td></tr>` : "";
      const campaignRow = utm_campaign ? `<tr><td style="padding: 10px 0; color: #6b7280;">Campaign</td><td style="padding: 10px 0; font-size: 13px;">${utm_source || "-"} / ${utm_medium || "-"} / ${utm_campaign}${utm_content ? " / " + utm_content : ""}</td></tr>` : "";

      const subjectCompany = company ? ` from ${company}` : "";
      const notificationEmail = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: "Starbot Leads <hello@starbot.co.uk>",
          to: [NOTIFY_EMAIL],
          subject: `New Lead: ${name || firstName}${subjectCompany}`,
          html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px;"><div style="margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #2DB6B7;"><span style="font-size: 14px; font-weight: 700; letter-spacing: 1px;">NEW LEAD</span></div><table style="width: 100%; border-collapse: collapse; font-size: 15px;"><tr><td style="padding: 10px 0; color: #6b7280; width: 100px;">Name</td><td style="padding: 10px 0;">${name || firstName}</td></tr>${companyRow}${roleRow}${emailRow}<tr><td style="padding: 10px 0; color: #6b7280;">Phone</td><td style="padding: 10px 0;">${cleanedPhone}</td></tr>${qualRow}${messageRow}${campaignRow}</table></div>`,
        }),
      });
      if (!notificationEmail.ok) {
        console.error("Notification email error:", await notificationEmail.text());
      }
    } catch (notifyErr) {
      console.error("Notification email throw (non-fatal):", notifyErr);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
