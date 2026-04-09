import { createClient } from "@supabase/supabase-js";

// Strip quoted reply — return only the new text above the first quote marker
function stripQuotedReply(text) {
  if (!text) return "";

  const lines = text.split(/\r?\n/);
  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // "On ... wrote:" (Gmail, Apple Mail)
    if (/^On .+ wrote:$/.test(line)) { cutIndex = i; break; }
    // "Le ... a écrit :" (French)
    if (/^Le .+ a écrit\s*:$/.test(line)) { cutIndex = i; break; }
    // "Am ... schrieb ...:" (German)
    if (/^Am .+ schrieb .+:$/.test(line)) { cutIndex = i; break; }
    // "El ... escribió:" (Spanish)
    if (/^El .+ escribió:$/.test(line)) { cutIndex = i; break; }
    // "-------- Original Message --------" (Outlook)
    if (/^-{4,}\s*Original Message\s*-{4,}$/.test(line)) { cutIndex = i; break; }
    // "-------- Forwarded message --------"
    if (/^-{4,}\s*Forwarded message\s*-{4,}$/.test(line)) { cutIndex = i; break; }
    // Lines starting with ">" (quoted text block)
    if (/^>/.test(line)) { cutIndex = i; break; }
    // "From: ..." preceded by blank line (generic)
    if (/^From:/.test(line) && i > 0 && lines[i - 1].trim() === "") { cutIndex = i; break; }
  }

  return lines.slice(0, cutIndex).join("\n").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !resendKey) {
    console.error("[inbound-email] Missing env vars");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const payload = req.body;
    const eventType = payload.type || "unknown";

    // Only process inbound emails — ignore outbound events (sent, delivered, opened, etc.)
    if (eventType !== "email.received") {
      console.log(`[inbound-email] Skipping event type: ${eventType}`);
      return res.status(200).json({ ok: true, skipped: true });
    }

    const data = payload.data || {};
    const emailId = data.email_id;

    // Extract sender and subject from webhook payload
    const fromRaw = data.from || "";
    const subject = data.subject || "";

    const senderEmail =
      fromRaw.match(/<([^>]+)>/)?.[1]?.toLowerCase() ||
      fromRaw.trim().toLowerCase();

    if (!senderEmail) {
      console.warn("[inbound-email] No sender address in payload");
      return res.status(200).json({ ok: true });
    }

    // Fetch full email body from Resend API (webhook payload doesn't include body)
    let bodyText = "";
    if (emailId) {
      try {
        const emailRes = await fetch(
          `https://api.resend.com/emails/receiving/${emailId}`,
          { headers: { Authorization: `Bearer ${resendKey}` } },
        );
        if (emailRes.ok) {
          const emailData = await emailRes.json();
          console.log(
            `[inbound-email] Resend response keys: ${Object.keys(emailData).join(", ")}`,
          );
          bodyText = emailData.text || emailData.html || "";
        } else {
          const errText = await emailRes.text().catch(() => "");
          console.error(
            `[inbound-email] Resend API ${emailRes.status}: ${errText}, emailId: ${emailId}`,
          );
        }
      } catch (fetchErr) {
        console.error("[inbound-email] Resend fetch error:", fetchErr.message);
      }
    }

    // Strip quoted reply text
    bodyText = stripQuotedReply(bodyText);

    console.log(
      `[inbound-email] Inbound from ${senderEmail}, subject: "${subject}", body length: ${bodyText.length}`,
    );

    // Match sender to a lead by email
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    const { data: lead, error: lookupErr } = await sb
      .from("starbot_leads")
      .select("id, conversation_log")
      .eq("email", senderEmail)
      .maybeSingle();

    if (lookupErr) {
      console.error("[inbound-email] Lead lookup failed:", lookupErr.message);
      return res.status(200).json({ ok: true });
    }

    if (!lead) {
      console.log(`[inbound-email] Unmatched inbound from ${senderEmail}`);
      return res.status(200).json({ ok: true, matched: false });
    }

    // Append to conversation_log
    const log = Array.isArray(lead.conversation_log)
      ? lead.conversation_log
      : [];
    log.push({
      date: new Date().toISOString(),
      from: "lead",
      subject: subject || null,
      text: bodyText,
      tag: "Reply",
    });

    const { error: updateErr } = await sb
      .from("starbot_leads")
      .update({ conversation_log: log })
      .eq("id", lead.id);

    if (updateErr) {
      console.error(
        "[inbound-email] Failed to update conversation_log:",
        updateErr.message,
      );
    }

    console.log(
      `[inbound-email] Saved reply from ${senderEmail} to lead ${lead.id}`,
    );
    return res.status(200).json({ ok: true, matched: true });
  } catch (err) {
    console.error("[inbound-email] error:", err);
    return res.status(200).json({ ok: true });
  }
}
