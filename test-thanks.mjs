#!/usr/bin/env node
// Unit tests for the four message-text branches on /api/thanks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "./api/thanks.js";
import { __test__ as phoneTest } from "./api/lead-context-by-phone.js";

test("branch 1: name + venue + ref", () => {
  assert.equal(
    buildMessage({ name: "John", venue: "The Crown", ref: "ABC23456" }),
    "Hi, I'm John from The Crown. I just submitted the Starbot form (ref: ABC23456)"
  );
});

test("branch 2: name + ref, no venue", () => {
  assert.equal(
    buildMessage({ name: "John", venue: null, ref: "ABC23456" }),
    "Hi, I'm John. I just submitted the Starbot form (ref: ABC23456)"
  );
});

test("branch 3: ref only", () => {
  assert.equal(
    buildMessage({ name: null, venue: null, ref: "ABC23456" }),
    "Hi, I just submitted the Starbot form (ref: ABC23456)"
  );
});

test("branch 4a: no ref, no name -> generic", () => {
  assert.equal(
    buildMessage({ name: null, venue: null, ref: null }),
    "Hi, I just submitted the Starbot form"
  );
});

test("branch 4b: no ref, name + venue from URL", () => {
  // Race-condition fallback after phone-lookup 404: still personalise using
  // what Meta passed in the redirect.
  assert.equal(
    buildMessage({ name: "John", venue: "The Crown", ref: null }),
    "Hi, I'm John from The Crown. I just submitted the Starbot form"
  );
});

test("branch 4c: no ref, name only", () => {
  assert.equal(
    buildMessage({ name: "John", venue: null, ref: null }),
    "Hi, I'm John. I just submitted the Starbot form"
  );
});

test("phone normaliser (lead-context-by-phone): GB default region", () => {
  const cases = [
    ["07911 123456", "+447911123456"],
    ["+44 7911 123456", "+447911123456"],
    ["447911123456", "+447911123456"],
    ["00447911123456", "+447911123456"],
    ["+34694906794", "+34694906794"],
    ["969013374", null],   // junk
    ["", null],
    [null, null],
  ];
  for (const [raw, want] of cases) {
    assert.equal(phoneTest.normalisePhone(raw), want, `phone(${JSON.stringify(raw)})`);
  }
});

test("URL-encoding survives the colon, spaces, parens, ampersand", () => {
  const msg = buildMessage({ name: "John & Jane", venue: "The Crown (Soho)", ref: "ABC23456" });
  const encoded = encodeURIComponent(msg);
  // The wa.me text param expects the message URL-encoded.
  assert.ok(encoded.includes("%20"), "spaces encoded");
  assert.ok(encoded.includes("%3A"), "colon encoded");
  assert.ok(encoded.includes("%26"), "ampersand encoded");
  // Parens and apostrophe are NOT encoded by encodeURIComponent (unreserved
  // per RFC 3986). WhatsApp accepts them raw in the wa.me text param.
  // And round-trips back cleanly.
  assert.equal(decodeURIComponent(encoded), msg);
});
