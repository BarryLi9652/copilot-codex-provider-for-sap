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

const EXACT_SENSITIVE_KEYS = new Set([
  "apikey",
  "credential",
  "credentials",
  "clientsecret",
  "authorizationheader",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSensitiveKey = (key: string): boolean => {
  const normalizedKey = normalizeKey(key);
  return EXACT_SENSITIVE_KEYS.has(normalizedKey)
    || [...SENSITIVE_KEY_MARKERS].some((marker) => normalizedKey.includes(marker));
};

const isUriKey = (key: string): boolean => {
  const normalizedKey = normalizeKey(key);
  return (
    normalizedKey === "uri" ||
    normalizedKey === "url" ||
    normalizedKey.endsWith("uri") ||
    normalizedKey.endsWith("uris") ||
    normalizedKey.endsWith("url") ||
    normalizedKey.endsWith("urls")
  );
};

const stripUriQueryAndFragment = (value: string): string => {
  const queryIndex = value.indexOf("?");
  const fragmentIndex = value.indexOf("#");
  const cutIndex = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return cutIndex === undefined ? value : value.slice(0, cutIndex);
};

const redactUri = (value: string): string => {
  const withoutQuery = stripUriQueryAndFragment(value);
  try {
    new URL(value);
  } catch {
    return withoutQuery;
  }
  const authorityStart = withoutQuery.indexOf("://");
  if (authorityStart < 0) {
    return withoutQuery;
  }
  const authorityOffset = authorityStart + 3;
  const pathStart = withoutQuery.indexOf("/", authorityOffset);
  const authorityEnd = pathStart < 0 ? withoutQuery.length : pathStart;
  const authority = withoutQuery.slice(authorityOffset, authorityEnd);
  const userinfoEnd = authority.lastIndexOf("@");
  if (userinfoEnd < 0) {
    return withoutQuery;
  }
  return withoutQuery.slice(0, authorityOffset)
    + authority.slice(userinfoEnd + 1)
    + withoutQuery.slice(authorityEnd);
};

const redactTokenValues = (value: string): string => value
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+={0,2}/gi, "$1[REDACTED]")
  .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);

const redactValue = (
  value: unknown,
  seen: WeakSet<object>,
  uriLike = false,
): unknown => {
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

  if (value instanceof Error) {
    return REDACTED;
  }

  if (uriLike && typeof value === "string") {
    return redactUri(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return REDACTED;
    }
    seen.add(value);
    const redacted = value.map((entry) => redactValue(entry, seen, uriLike));
    seen.delete(value);
    return redacted;
  }

  if (typeof value === "string") {
    return redactTokenValues(value);
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
    } else {
      redacted[key] = redactValue(entry, seen, uriLike || isUriKey(key));
    }
  }

  seen.delete(value);
  return redacted;
};

export function redactMetadata(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
