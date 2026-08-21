import type { CodexErrorCode } from "../core/errors.js";

const SAFE_ERROR_CODES = new Set<CodexErrorCode>([
  "authRequired",
  "unauthorized",
  "rateLimited",
  "network",
  "timeout",
  "cancelled",
  "protocol",
  "process",
  "incompatible",
  "toolContinuation",
  "sapContext",
]);
const MAX_ERROR_CODES = 10;

export interface DiagnosticsRouteSnapshot {
  readonly available: boolean;
  readonly modelCount?: number;
  readonly cacheAgeMs?: number;
}

export interface DiagnosticsSnapshot {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: string;
  readonly chatgpt: DiagnosticsRouteSnapshot;
  readonly local: DiagnosticsRouteSnapshot;
  readonly executablePath?: string;
  readonly appServer?: {
    readonly processState: "stopped" | "starting" | "running" | "terminating" | "stuck" | "exited";
    readonly serverVersion?: string;
    readonly dynamicTools?: boolean;
    readonly accountType?: "chatgpt" | "personalAccessToken";
  };
  readonly sap: {
    readonly abapFsInstalled: boolean;
    readonly adtInstalled: boolean;
  };
  readonly lastErrorCodes: readonly CodexErrorCode[];
}

export class DiagnosticsHistory {
  private readonly codes: CodexErrorCode[] = [];

  public record(error: unknown): void {
    const code = readSafeCode(error);
    if (code === undefined || code === "cancelled") {
      return;
    }
    this.codes.push(code);
    if (this.codes.length > MAX_ERROR_CODES) {
      this.codes.splice(0, this.codes.length - MAX_ERROR_CODES);
    }
  }

  public clear(): void {
    this.codes.length = 0;
  }

  public snapshot(): readonly CodexErrorCode[] {
    return [...this.codes];
  }
}

const readSafeCode = (error: unknown): CodexErrorCode | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODES.has(code as CodexErrorCode)
    ? code as CodexErrorCode
    : undefined;
};

const redactedExecutablePath = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) {
    return "unavailable";
  }
  return value
    .replace(/([\\/]Users[\\/])[^\\/]+/i, "$1<user>")
    .replace(/([\\/]home[\\/])[^\\/]+/i, "$1<user>")
    .replace(/([\\/]Documents and Settings[\\/])[^\\/]+/i, "$1<user>");
};

const safeCount = (value: number | undefined): number | null =>
  value !== undefined && Number.isInteger(value) && value >= 0 ? value : null;

const safeAgeSeconds = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value / 1_000)
    : null;

const safeVersion = (value: string | undefined): string | null =>
  value !== undefined
  && value.length <= 64
  && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
    ? value
    : null;

export function buildDiagnosticsReport(snapshot: DiagnosticsSnapshot): string {
  const report = {
    extension: {
      version: snapshot.extensionVersion,
      vscodeVersion: snapshot.vscodeVersion,
      platform: snapshot.platform,
    },
    providers: {
      chatgptOAuth: {
        available: snapshot.chatgpt.available,
        modelCount: safeCount(snapshot.chatgpt.modelCount),
        cacheAgeSeconds: safeAgeSeconds(snapshot.chatgpt.cacheAgeMs),
      },
      localCli: {
        available: snapshot.local.available,
        modelCount: safeCount(snapshot.local.modelCount),
        cacheAgeSeconds: safeAgeSeconds(snapshot.local.cacheAgeMs),
      },
    },
    local: {
      executablePath: redactedExecutablePath(snapshot.executablePath),
      appServer: snapshot.appServer === undefined ? null : {
        processState: snapshot.appServer.processState,
        serverVersion: safeVersion(snapshot.appServer.serverVersion),
        dynamicTools: snapshot.appServer.dynamicTools ?? null,
        accountType: snapshot.appServer.accountType ?? null,
      },
    },
    sapExtensions: {
      abapFsInstalled: snapshot.sap.abapFsInstalled,
      adtInstalled: snapshot.sap.adtInstalled,
    },
    lastErrorCodes: snapshot.lastErrorCodes.filter((code) => SAFE_ERROR_CODES.has(code)),
  };
  return JSON.stringify(report, undefined, 2);
}
