import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { extractJwtMetadata, type OAuthSession } from "./oauth-store.js";

interface LocalCodexTokens {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly account_id?: unknown;
}

interface LocalCodexAuthFile {
  readonly auth_mode?: unknown;
  readonly tokens?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const readJwtExpiry = (token: string): number | undefined => {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(value) && typeof value.exp === "number" && Number.isFinite(value.exp)
      ? value.exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads the existing ChatGPT credentials written by the local Codex CLI.
 * The caller must persist the returned value in SecretStorage; this helper
 * never logs or returns the raw file payload.
 */
export async function readLocalCodexOAuthSession(
  authFilePath = join(homedir(), ".codex", "auth.json"),
): Promise<OAuthSession> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(authFilePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Could not read the local Codex ChatGPT session.", { cause: error });
  }

  const auth = isRecord(value) ? value as LocalCodexAuthFile : undefined;
  const tokens = auth !== undefined && isRecord(auth.tokens)
    ? auth.tokens as LocalCodexTokens
    : undefined;
  const accessToken = nonEmptyString(tokens?.access_token);
  const refreshToken = nonEmptyString(tokens?.refresh_token);
  if (auth?.auth_mode !== "chatgpt" || accessToken === undefined || refreshToken === undefined) {
    throw new Error("The local Codex CLI is not signed in with a ChatGPT account.");
  }

  const metadata = extractJwtMetadata(accessToken);
  return {
    accessToken,
    refreshToken,
    // An expired access token is intentionally accepted: OAuthManager will
    // refresh it through the normal token endpoint before its first request.
    // A fallback at the current instant is valid persisted session data and
    // deliberately makes OAuthManager refresh before its first API request.
    expiresAt: readJwtExpiry(accessToken) ?? Date.now(),
    ...(nonEmptyString(tokens?.account_id) ?? metadata.accountId
      ? { accountId: nonEmptyString(tokens?.account_id) ?? metadata.accountId }
      : {}),
    ...(metadata.email === undefined ? {} : { email: metadata.email }),
  };
}
