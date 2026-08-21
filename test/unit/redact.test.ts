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

test("redacts every case variant of the sensitive metadata keys", () => {
  const sensitive = {
    aUtHoRiZaTiOn: "authorization-secret",
    cOoKiE: "cookie-secret",
    ToKeN: "token-secret",
    sEcReT: "secret-value",
    pAsSwOrD: "password-secret",
    PrOmPt: "private prompt",
    MeSsAgE: "private message",
    CoNtEnT: "private content",
    SoUrCe: "REPORT z_private.",
    ArGuMeNtS: { private: true },
    InPuT: "private input",
    OuTpUt: "private output",
    tOoLrEsUlT: { private: true },
    ToOl_ReSuLt: { private: true },
  };

  const redacted = redactMetadata(sensitive);

  assert.deepEqual(
    redacted,
    Object.fromEntries(Object.keys(sensitive).map((key) => [key, "[REDACTED]"])),
  );
});

test("preserves safe nested operational metadata and redacts nested content", () => {
  const redacted = redactMetadata({
    request: {
      status: 200,
      durationMs: 12,
      provider: "sap",
      method: "GET",
      requestId: "request-1",
      exitCode: 0,
      details: [
        { status: 201, content: "private model content" },
        { source: "REPORT z_private." },
      ],
    },
  });

  assert.deepEqual(redacted, {
    request: {
      status: 200,
      durationMs: 12,
      provider: "sap",
      method: "GET",
      requestId: "request-1",
      exitCode: 0,
      details: [
        { status: 201, content: "[REDACTED]" },
        { source: "[REDACTED]" },
      ],
    },
  });
});

test("redacts URI query and fragment data through nested arrays", () => {
  const redacted = redactMetadata({
    uri: [
      "adt://DEV/first?password=query#fragment",
      ["adt://DEV/second#fragment", ["adt://DEV/third?client=100#fragment"]],
    ],
    requestUri: [["adt://DEV/fourth?token=query#fragment"]],
  });

  assert.deepEqual(redacted, {
    uri: [
      "adt://DEV/first",
      ["adt://DEV/second", ["adt://DEV/third"]],
    ],
    requestUri: [["adt://DEV/fourth"]],
  });
});

test("terminates cyclic metadata graphs with an explicit redaction", () => {
  const cycle: Record<string, unknown> = { status: 200 };
  cycle.self = cycle;

  assert.deepEqual(redactMetadata({ graph: cycle }), {
    graph: { status: 200, self: "[REDACTED]" },
  });
});

test("preserves logger envelope fields over redacted metadata", () => {
  const lines: string[] = [];
  const logger = new SafeLogger(
    { appendLine: (value: string) => lines.push(value) },
    () => "info",
  );

  logger.event("safe-event", {
    time: "not-the-generated-time",
    event: "Bearer injected-event-secret",
    status: 200,
  });

  const serialized = lines[0] ?? "";
  const event = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(event.event, "safe-event");
  assert.notEqual(event.time, "not-the-generated-time");
  assert.match(String(event.time), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.status, 200);
  assert.equal(serialized.includes("injected-event-secret"), false);
});

test("safe logger honors the configured log-level threshold", () => {
  const lines: string[] = [];
  const logger = new SafeLogger(
    { appendLine: (value: string) => lines.push(value) },
    () => "warn",
  );

  logger.event("info-event");
  logger.event("warning-event", {}, "warn");
  logger.event("error-event", {}, "error");
  logger.event("debug-event", {}, "debug");

  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { event: string }).event), [
    "warning-event",
    "error-event",
  ]);
});

test("redacts ordinary Error values without exposing message or stack", () => {
  const error = new Error("private generic error message");
  Object.defineProperty(error, "message", {
    configurable: true,
    enumerable: true,
    value: "private generic error message",
  });
  Object.defineProperty(error, "stack", {
    configurable: true,
    enumerable: true,
    value: "private generic error stack",
  });

  const redacted = redactMetadata({ error });

  assert.deepEqual(redacted, { error: "[REDACTED]" });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("private generic error message"), false);
  assert.equal(serialized.includes("private generic error stack"), false);
});
