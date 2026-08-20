import {
  CHATGPT_OAUTH_SECRET_KEY,
  type CHATGPT_CODEX_PROFILE,
} from "./profile.js";

export { CHATGPT_OAUTH_SECRET_KEY } from "./profile.js";

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface OAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

export interface OAuthCredentials {
  token: string;
  accountId?: string;
}

export interface OAuthJwtMetadata {
  accountId?: string;
  email?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const optionalString = (value: unknown): string | undefined =>
  isNonEmptyString(value) ? value : undefined;

const readNestedString = (
  value: Record<string, unknown>,
  objectKey: string,
  fieldKey: string,
): string | undefined => {
  const nested = value[objectKey];
  return isRecord(nested) ? optionalString(nested[fieldKey]) : undefined;
};

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) {
    return undefined;
  }

  try {
    const payload = Buffer.from(segments[1], "base64url").toString("utf8");
    const value: unknown = JSON.parse(payload);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const extractJwtMetadata = (token: string): OAuthJwtMetadata => {
  const claims = decodeJwtPayload(token);
  if (!claims) {
    return {};
  }

  const accountId =
    readNestedString(claims, "https://api.openai.com/auth", "chatgpt_account_id") ??
    optionalString(claims.chatgpt_account_id) ??
    optionalString(claims.account_id);
  const email =
    optionalString(claims.email) ??
    readNestedString(claims, "https://api.openai.com/auth", "email");

  return { accountId, email };
};

export const parseOAuthSession = (value: unknown): OAuthSession | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isNonEmptyString(value.accessToken) || !isNonEmptyString(value.refreshToken)) {
    return undefined;
  }
  if (
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0
  ) {
    return undefined;
  }

  const accountId = optionalString(value.accountId);
  const email = optionalString(value.email);
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    ...(accountId === undefined ? {} : { accountId }),
    ...(email === undefined ? {} : { email }),
  };
};

export class OAuthStore {
  public constructor(
    private readonly secrets: SecretStore,
    private readonly key: string = CHATGPT_OAUTH_SECRET_KEY,
  ) {}

  public async load(): Promise<OAuthSession | undefined> {
    const serialized = await this.secrets.get(this.key);
    if (serialized === undefined) {
      return undefined;
    }

    try {
      return parseOAuthSession(JSON.parse(serialized) as unknown);
    } catch {
      return undefined;
    }
  }

  public async save(session: OAuthSession): Promise<void> {
    await this.secrets.store(this.key, JSON.stringify(session));
  }

  public async clear(): Promise<void> {
    await this.secrets.delete(this.key);
  }
}

export type ChatGptCodexProfile = typeof CHATGPT_CODEX_PROFILE;
