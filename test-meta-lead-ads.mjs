#!/usr/bin/env node
// Unit tests for api/webhooks/meta-lead-ads.js
//
// Runs entirely offline. Tests:
//   1. verifySignature accepts a correct sha256 HMAC and rejects bad ones.
//   2. normalisePhone covers the same shape matrix as PR 1.
//   3. indexFieldData + pickField extract Meta lead form fields by name.
//   4. VENUE_TYPE_MAP translates Meta dropdown labels to schema enum values.
//   5. reserveRefCode retries on collision and gives up after REF_MAX_ATTEMPTS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { __test__ } from "./api/webhooks/meta-lead-ads.js";

const {
  verifySignature,
  normalisePhone,
  indexFieldData,
  pickField,
  reserveRefCode,
  VENUE_TYPE_MAP,
  REF_MAX_ATTEMPTS,
} = __test__;

test("verifySignature: accepts correct HMAC", () => {
  const secret = "shh";
  const body = Buffer.from('{"hello":"world"}');
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifySignature(body, sig, secret), true);
});

test("verifySignature: rejects bad signature, wrong secret, malformed header", () => {
  const body = Buffer.from('{"hello":"world"}');
  const good = "sha256=" + createHmac("sha256", "shh").update(body).digest("hex");
  assert.equal(verifySignature(body, good, "WRONG"), false, "wrong secret");
  assert.equal(verifySignature(body, "sha256=deadbeef", "shh"), false, "wrong digest");
  assert.equal(verifySignature(body, "deadbeef", "shh"), false, "missing prefix");
  assert.equal(verifySignature(body, undefined, "shh"), false, "missing header");
  assert.equal(verifySignature(body, "sha256=zz", "shh"), false, "non-hex");
});

test("normalisePhone: PR 1 shape matrix", () => {
  const cases = [
    ["07911 123456", "+447911123456"],   // leading_zero, with space
    ["+44 7911 123456", "+447911123456"], // plus_prefix, with spaces
    ["447911123456", "+447911123456"],    // leading_44
    ["00447911123456", "+447911123456"],  // double_zero
    ["+34694906794", "+34694906794"],     // foreign plus
    ["969013374", null],                   // junk: 9-digit no country
    ["456789876543456", null],             // junk: 15-digit
    [null, null],
    ["", null],
    ["   ", null],
  ];
  for (const [raw, want] of cases) {
    assert.equal(normalisePhone(raw), want, `phone(${JSON.stringify(raw)})`);
  }
});

test("indexFieldData + pickField: extract Meta field_data", () => {
  const fd = [
    { name: "full_name", values: ["Jane Doe"] },
    { name: "WhatsApp number", values: ["+447911123456"] },
    { name: "business_or_venue_name", values: ["Acme Cafe"] },
    { name: "venue_type", values: ["Shopping centre"] },
    { name: "location_or_city", values: ["London"] },
    { name: "approximate_daily_foot_traffic_or_headcount", values: ["2000"] },
  ];
  const m = indexFieldData(fd);
  assert.equal(pickField(m, ["full_name", "name"]), "Jane Doe");
  assert.equal(pickField(m, ["whatsapp_number", "phone"]), "+447911123456");
  assert.equal(pickField(m, ["business_or_venue_name"]), "Acme Cafe");
  assert.equal(pickField(m, ["venue_type"]), "Shopping centre");
  assert.equal(pickField(m, ["location_or_city"]), "London");
  assert.equal(pickField(m, ["approximate_daily_foot_traffic_or_headcount"]), "2000");
  assert.equal(pickField(m, ["does_not_exist"]), null);
});

test("VENUE_TYPE_MAP: covers all 8 brief options", () => {
  const expected = {
    retail: "retail",
    office: "office",
    hospitality: "hospitality",
    "shopping centre": "shopping_centre",
    gym: "gym",
    "transport hub": "transport_hub",
    education: "education",
    other: "other",
  };
  for (const [label, enumVal] of Object.entries(expected)) {
    assert.equal(VENUE_TYPE_MAP[label], enumVal, `venue ${label}`);
  }
  // US/UK spelling alias
  assert.equal(VENUE_TYPE_MAP["shopping center"], "shopping_centre");
});

// --- reserveRefCode retry tests --------------------------------------------

function makeStubSupabase(existingCodes) {
  // Mimics: sb.from('starbot_leads').select('id').eq('lead_ref_code', code).limit(1).maybeSingle()
  return {
    from() {
      const state = { code: null };
      const chain = {
        select() { return chain; },
        eq(_col, value) { state.code = value; return chain; },
        limit() { return chain; },
        async maybeSingle() {
          if (existingCodes.has(state.code)) return { data: { id: "exists" }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

test("reserveRefCode: succeeds on first attempt when no collision", async () => {
  const sb = makeStubSupabase(new Set());
  const code = await reserveRefCode(sb, () => "AAAAAAAA");
  assert.equal(code, "AAAAAAAA");
});

test("reserveRefCode: retries on collision, succeeds within budget", async () => {
  const sb = makeStubSupabase(new Set(["DUPE1111", "DUPE2222", "DUPE3333"]));
  const gen = (() => {
    const seq = ["DUPE1111", "DUPE2222", "DUPE3333", "FRESH444", "NEVER"];
    let i = 0;
    return () => seq[i++];
  })();
  const code = await reserveRefCode(sb, gen);
  assert.equal(code, "FRESH444");
});

test(`reserveRefCode: throws after ${REF_MAX_ATTEMPTS} consecutive collisions`, async () => {
  const dupes = new Set(["D1","D2","D3","D4","D5","D6","D7","D8"]);
  const sb = makeStubSupabase(dupes);
  const seq = ["D1","D2","D3","D4","D5","D6","D7","D8"];
  let i = 0;
  await assert.rejects(
    reserveRefCode(sb, () => seq[i++]),
    /collision after 5 attempts/,
  );
  // Should have tried exactly REF_MAX_ATTEMPTS times.
  assert.equal(i, REF_MAX_ATTEMPTS);
});
