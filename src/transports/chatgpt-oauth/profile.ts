export const CHATGPT_CODEX_PROFILE = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  callbackPorts: [1455, 1457] as const,
  callbackPath: "/auth/callback",
  scope: "openid email profile offline_access",
  originator: "copilot-codex-provider-for-sap",
  modelsClientVersion: "0.146.0",
  modelsUrl: "https://chatgpt.com/backend-api/codex/models",
  responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
} as const;

export const CHATGPT_OAUTH_SECRET_KEY = "copilotCodex.chatgptOAuth.v1";
export const CHATGPT_CALLBACK_HOST = "127.0.0.1";
export const CHATGPT_REDIRECT_HOST = "localhost";
export const CHATGPT_CALLBACK_TIMEOUT_MS = 300_000;
export const CHATGPT_EXPIRY_SKEW_MS = 60_000;
export const CHATGPT_DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;
