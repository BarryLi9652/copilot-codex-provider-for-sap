import { CodexError } from "../core/errors.js";

const REDACTED = "[REDACTED]";
const normalizeKey = (key: string): string => key.replace(/[\s_-]/g, "").toLowerCase();

const SENSITIVE_KEY_MARKERS = new Set(
  [
    "authorization",
    "cookie",
    "token",
    "secret",
    "password",
    "prompt",
    "message",
    "content",
    "source",
    "arguments",
    "input",
    "output",
    "toolResult",
    "tool_result",
  ].map(normalizeKey),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSensitiveKey = (key: string): boolean => {
  const normalizedKey = normalizeKey(key);
  return [...SENSITIVE_KEY_MARKERS].some((marker) => normalizedKey.includes(marker));
};

const isUriKey = (key: string): boolean => {
  const normalizedKey = normalizeKey(key);
  return normalizedKey === "uri" || normalizedKey === "url" || normalizedKey.endsWith("uri");
};

const stripUriQueryAndFragment = (value: string): string => {
  const queryIndex = value.indexOf("?");
  const fragmentIndex = value.indexOf("#");
  const cutIndex = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return cutIndex === undefined ? value : value.slice(0, cutIndex);
};

const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value instanceof CodexError) {
    const safeError: Record<string, unknown> = { code: value.code };
    if (value.action !== undefined) {
      safeError.action = value.action;
    }
    if (value.retryAfterMs !== undefined) {
      safeError.retryAfterMs = value.retryAfterMs;
    }
    return safeError;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return REDACTED;
    }
    seen.add(value);
    const redacted = value.map((entry) => redactValue(entry, seen));
    seen.delete(value);
    return redacted;
  }

  if (!isRecord(value)) {
    return value;
  }

  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      redacted[key] = REDACTED;
    } else if (isUriKey(key) && typeof entry === "string") {
      redacted[key] = stripUriQueryAndFragment(entry);
    } else {
      redacted[key] = redactValue(entry, seen);
    }
  }

  seen.delete(value);
  return redacted;
};

export function redactMetadata(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
