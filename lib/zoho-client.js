// Zoho CRM push for inbound landing leads. Extracted from api/submit-lead.js
// when /quiz was added as a second landing route with a distinct
// Lead_Source attribution. Locked in
// vault/decisions/quiz-landing-locked-may26.md (in the starbot-crm repo).
//
// One-way fire-and-forget. Errors are logged, never thrown. The caller
// returns to the user immediately; the v2 CRM picks up the lead either
// from the Zoho mirror cron or from the parallel Supabase edge function
// write.

const DEFAULT_LEAD_SOURCE = "Starbot Landing Page";

function buildZohoDescription({ message, quiz, utm, leadRefCode }) {
  const utmBlock =
    `UTM Source: ${utm.source || "-"}\n` +
    `UTM Medium: ${utm.medium || "-"}\n` +
    `UTM Campaign: ${utm.campaign || "-"}\n` +
    `UTM Content: ${utm.content || "-"}`;
  const quizBlock =
    `Location type: ${quiz.locationType || "-"}\n` +
    `Coffee timeline: ${quiz.coffeeTimeline || "-"}\n` +
    `London zone: ${quiz.londonZone || "-"}`;

  const sections = [];
  // ref:<code> goes first so a `LIKE 'ref:%'` parser on the
  // mirrored zoho_description column catches it without parsing the
  // whole body. See vault/playbooks/lead-match-logic.md.
  if (leadRefCode) sections.push(`ref:${leadRefCode}`);
  if (message && message.trim()) sections.push(message.trim());
  sections.push(quizBlock);
  sections.push(utmBlock);
  return sections.join("\n\n---\n");
}

export function pushToZoho({
  firstName,
  lastName,
  email,
  phone,
  postcode,
  company,
  role,
  message,
  leadSource,
  leadRefCode,
  locationType,
  coffeeTimeline,
  londonZone,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
}) {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const accountsUrl = process.env.ZOHO_ACCOUNTS_URL;
  const apiUrl = process.env.ZOHO_API_URL;

  if (!clientId || !clientSecret || !refreshToken || !accountsUrl || !apiUrl) {
    console.warn("Zoho env vars not all set, skipping Zoho push");
    return;
  }

  (async () => {
    const tokenParams = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });

    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      console.error("Zoho OAuth failed:", tokenRes.status, errText);
      return;
    }

    const tokenJson = await tokenRes.json().catch(() => ({}));
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      console.error(
        "Zoho OAuth failed: no access_token in response",
        tokenJson,
      );
      return;
    }

    const leadRecord = {
      Last_Name: lastName && lastName.trim() ? lastName : "-",
      First_Name: firstName,
      Company: company || "-",
      Lead_Source: leadSource || DEFAULT_LEAD_SOURCE,
      Description: buildZohoDescription({
        message,
        leadRefCode,
        quiz: {
          locationType,
          coffeeTimeline,
          londonZone,
        },
        utm: {
          source: utmSource,
          medium: utmMedium,
          campaign: utmCampaign,
          content: utmContent,
        },
      }),
    };
    if (email) leadRecord.Email = email;
    if (phone) leadRecord.Phone = phone;
    if (role) leadRecord.Title = role;
    if (postcode) leadRecord.Postal_Code = postcode;

    const leadRes = await fetch(`${apiUrl}/crm/v2/Leads`, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: [leadRecord],
        trigger: ["workflow"],
      }),
    });

    const leadBody = await leadRes.json().catch(() => ({}));
    const record = leadBody?.data?.[0];

    if (!leadRes.ok || record?.code !== "SUCCESS") {
      console.error(
        "Zoho lead push failed:",
        leadRes.status,
        JSON.stringify(leadBody),
      );
      return;
    }

    console.log("Zoho lead created:", record?.details?.id);
  })().catch((err) => console.error("Zoho lead push error:", err));
}
