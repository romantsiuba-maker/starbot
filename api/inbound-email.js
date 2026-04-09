import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
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

    // Resend email.received payload includes the full email inline
    const fromRaw = data.from || "";
    const subject = data.subject || "";
    const bodyText = data.text || data.html || "";

    // Extract sender email address
    const senderEmail =
      fromRaw.match(/<([^>]+)>/)?.[1]?.toLowerCase() ||
      fromRaw.trim().toLowerCase();

    if (!senderEmail) {
      console.warn("[inbound-email] No sender address in payload");
      return res.status(200).json({ ok: true });
    }

    console.log(
      `[inbound-email] Inbound from ${senderEmail}, subject: "${subject}"`,
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
