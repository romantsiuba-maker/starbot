import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!resendKey || !supabaseUrl || !supabaseServiceKey) {
    console.error("Missing env vars for send-reply");
    return res.status(503).json({ error: "Service not configured" });
  }

  try {
    const { leadId, to, subject, body } = req.body;

    if (!leadId || !to || !body?.trim()) {
      return res.status(400).json({ error: "Missing leadId, to, or body" });
    }

    // Send email via Resend
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: "Roman <hello@starbot.co.uk>",
        reply_to: "leads@reply.starbot.co.uk",
        to: [to],
        subject: subject || "Re: Starbot Partnership",
        html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; color: #1a2b4a; line-height: 1.6;">${body
          .trim()
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => `<p>${escapeHtml(l)}</p>`)
          .join("")}</div>`,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text().catch(() => "");
      console.error(`Resend send failed (${emailRes.status}):`, errText);
      return res.status(500).json({ error: "Failed to send email" });
    }

    // Append to conversation_log
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    const { data: lead, error: fetchErr } = await sb
      .from("starbot_leads")
      .select("conversation_log")
      .eq("id", leadId)
      .single();

    if (fetchErr) {
      console.error("Failed to fetch lead:", fetchErr.message);
      return res.status(500).json({ error: "Failed to update conversation" });
    }

    const log = Array.isArray(lead.conversation_log)
      ? lead.conversation_log
      : [];
    log.push({
      date: new Date().toISOString(),
      from: "roman",
      subject: subject || null,
      text: body.trim(),
      tag: "Reply",
    });

    const { error: updateErr } = await sb
      .from("starbot_leads")
      .update({ conversation_log: log })
      .eq("id", leadId);

    if (updateErr) {
      console.error("Failed to update conversation_log:", updateErr.message);
      // Email already sent, so return partial success
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("send-reply error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
