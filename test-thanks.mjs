#!/usr/bin/env node
// Unit tests for the four message-text branches on /api/thanks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage } from "./api/thanks.js";

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

test("branch 4: no ref (with or without other fields) -> generic", () => {
  assert.equal(
    buildMessage({ name: null, venue: null, ref: null }),
    "Hi, I just submitted the Starbot form"
  );
  // Name/venue without ref still degrade to generic per brief.
  assert.equal(
    buildMessage({ name: "John", venue: "The Crown", ref: null }),
    "Hi, I just submitted the Starbot form"
  );
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
