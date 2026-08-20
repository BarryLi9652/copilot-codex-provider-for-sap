import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { SafeLogger } from "../../src/security/logger.js";
import { redactMetadata } from "../../src/security/redact.js";

test("redacts credentials, content, tool payloads, and SAP query strings", () => {
  const redacted = redactMetadata({
    Authorization: "Bearer secret",
    refreshToken: "refresh-secret",
    prompt: "private ABAP source",
    toolResult: { source: "REPORT z_private." },
    uri: "adt://DEV/object?password=secret&client=100",
    status: 429,
  });

  assert.deepEqual(redacted, {
    Authorization: "[REDACTED]",
    refreshToken: "[REDACTED]",
    prompt: "[REDACTED]",
    toolResult: "[REDACTED]",
    uri: "adt://DEV/object",
    status: 429,
  });
});

test("logs only a timestamped redacted event and safe CodexError metadata", () => {
  const lines: string[] = [];
  const logger = new SafeLogger(
    { appendLine: (value: string) => lines.push(value) },
    () => "info",
  );

  logger.event("request-failed", {
    status: 429,
    authorization: "Bearer secret",
    error: new CodexError("rateLimited", {
      action: "retry",
      cause: { prompt: "private ABAP source" },
    }),
  });

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
  assert.match(String(event.time), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.event, "request-failed");
  assert.equal(event.status, 429);
  assert.equal(event.authorization, "[REDACTED]");
  assert.deepEqual(event.error, { code: "rateLimited", action: "retry" });
  assert.equal(JSON.stringify(event).includes("private ABAP source"), false);
  assert.equal(JSON.stringify(event).includes("Bearer secret"), false);
});
