import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createOAuthState, createPkcePair } from "../../src/transports/chatgpt-oauth/pkce.js";

test("PKCE creates a base64url verifier and its S256 challenge", () => {
  const pair = createPkcePair();

  assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
  assert.ok(pair.verifier.length >= 43);
  assert.ok(pair.verifier.length <= 128);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    pair.challenge,
    createHash("sha256").update(pair.verifier).digest("base64url"),
  );
});

test("OAuth state values are unpredictable base64url strings", () => {
  const first = createOAuthState();
  const second = createOAuthState();

  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.match(second, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
});
