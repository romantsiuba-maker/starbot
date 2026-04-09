import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !resendKey) {
    console.error("Missing env vars for inbound-email");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const payload = req.body;

    // Log full payload for debugging
    console.log(
      "[inbound-email] Webhook payload:",
      JSON.stringify(payload, null, 2),
    );

    // Extract email_id from Resend webhook event
    const emailId = payload.data?.email_id || payload.email_id;
    if (!emailId) {
      console.warn("[inbound-email] No email_id in webhook payload");
      return res.status(200).json({ ok: true });
    }

    // Fetch full email content from Resend API
    const emailRes = await fetch(`https://api.resend.com/emails/${emailId}`, {
      headers: { Authorization: `Bearer ${resendKey}` },
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text().catch(() => "");
      console.error(
        `[inbound-email] Failed to fetch email ${emailId} (${emailRes.status}):`,
        errText,
      );
      return res.status(200).json({ ok: true });
    }

    const email = await emailRes.json();
    console.log("[inbound-email] Fetched email from:", email.from);

    // Extract sender email address
    const senderEmail =
      email.from?.match(/<([^>]+)>/)?.[1] || email.from?.trim() || "";

    if (!senderEmail) {
      console.warn("[inbound-email] No sender address in fetched email");
      return res.status(200).json({ ok: true });
    }

    const bodyText = email.text || email.html || "";
    const subject = email.subject || "";

    // Match sender to a lead by email
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    const { data: lead, error: lookupErr } = await sb
      .from("starbot_leads")
      .select("id, conversation_log")
      .eq("email", senderEmail.toLowerCase())
      .limit(1)
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
      text: bodyText.trim(),
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
