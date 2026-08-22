export type CodexErrorCode =
  | "authRequired"
  | "unauthorized"
  | "rateLimited"
  | "network"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "process"
  | "incompatible"
  | "toolContinuation"
  | "requiredToolMissing"
  | "sapContext";

export interface CodexErrorOptions {
  action?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export type ProviderRecoveryAction =
  | "signIn"
  | "refreshModels"
  | "selectCodex"
  | "restartCodex"
  | "upgradeCodex"
  | "showDiagnostics";

const DEFAULT_MESSAGES: Readonly<Record<CodexErrorCode, string>> = {
  authRequired: "Authentication is required.",
  unauthorized: "Authentication was rejected.",
  rateLimited: "The Codex service is rate limited.",
  network: "The Codex service could not be reached.",
  timeout: "The Codex request timed out.",
  cancelled: "The Codex request was cancelled.",
  protocol: "The Codex transport returned an invalid response.",
  process: "The Codex process failed.",
  incompatible: "The Codex transport is incompatible.",
  toolContinuation: "The Codex tool continuation could not be resumed.",
  requiredToolMissing: "The Codex turn completed without the required tool call.",
  sapContext: "The SAP context could not be read.",
};

export class CodexError extends Error {
  public readonly code: CodexErrorCode;
  public readonly action: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(code: CodexErrorCode, options: CodexErrorOptions = {}) {
    super(
      DEFAULT_MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CodexError";
    this.code = code;
    this.action = options.action;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const PROVIDER_ACTIONS = new Set<ProviderRecoveryAction>([
  "signIn",
  "refreshModels",
  "selectCodex",
  "restartCodex",
  "upgradeCodex",
  "showDiagnostics",
]);

const DEFAULT_PROVIDER_ACTION: Readonly<Record<Exclude<CodexErrorCode, "cancelled">, ProviderRecoveryAction>> = {
  authRequired: "signIn",
  unauthorized: "signIn",
  rateLimited: "showDiagnostics",
  network: "showDiagnostics",
  timeout: "showDiagnostics",
  protocol: "showDiagnostics",
  process: "restartCodex",
  incompatible: "upgradeCodex",
  toolContinuation: "restartCodex",
  requiredToolMissing: "showDiagnostics",
  sapContext: "showDiagnostics",
};

export function withProviderRecoveryAction(error: CodexError): CodexError {
  if (error.code === "cancelled") {
    return error;
  }
  const existing = error.action;
  const action = existing !== undefined && PROVIDER_ACTIONS.has(existing as ProviderRecoveryAction)
    ? existing as ProviderRecoveryAction
    : DEFAULT_PROVIDER_ACTION[error.code];
  if (action === existing) {
    return error;
  }
  return new CodexError(error.code, {
    action,
    retryAfterMs: error.retryAfterMs,
    cause: error.cause,
  });
}
