import { CodexError } from "../../core/errors.js";
import { ModelCache } from "../../core/model-cache.js";
import type { CodexModel } from "../../core/types.js";
import { SafeLogger } from "../../security/logger.js";
import {
  type Disposable,
  type JsonRpcServerNotificationHandler,
  type JsonRpcServerRequestHandler,
  protocolError,
} from "./protocol.js";
import { parseAppServerModels, type AppServerModelDiagnostics } from "./model-catalog.js";
import { APP_SERVER_THREAD_CONFIG } from "./safety-profile.js";

const APP_SERVER_CLIENT_NAME = "copilot_codex_provider_for_sap";
const DEFAULT_MODEL_CACHE_TTL_MS = 300_000;

const APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/permission/requestApproval",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

export interface AppServerCapabilities {
  dynamicTools: boolean;
  serverVersion?: string;
}

export interface AppServerAccount {
  type: "chatgpt" | "personalAccessToken";
  planType?: string;
}

export interface AppServerSessionClient {
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): void;
  onServerRequest(method: string, handler: JsonRpcServerRequestHandler): Disposable;
  onServerNotification?: (
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ) => Disposable;
  readonly isClosed?: boolean;
}

export interface AppServerSessionSupervisor {
  start(): Promise<AppServerSessionClient>;
  restart(): Promise<AppServerSessionClient>;
  stop(): Promise<void>;
  reportInitializationSuccess(client: AppServerSessionClient): void;
  reportInitializationFailure(client: AppServerSessionClient, cause?: unknown): Promise<void>;
}

export interface AppServerSessionOptions {
  extensionVersion: string;
  modelCacheTtlMs?: number;
  now?: () => number;
  logger?: SafeLogger;
}

interface ItemStartedParams {
  threadId?: unknown;
  turnId?: unknown;
  item?: unknown;
  type?: unknown;
  itemType?: unknown;
}

export class AppServerSession {
  private readonly supervisor: AppServerSessionSupervisor;
  private readonly extensionVersion: string;
  private readonly modelCache: ModelCache;
  private readonly logger: SafeLogger | undefined;
  private initializationPromise: Promise<AppServerCapabilities> | undefined;
  private restartPromise: Promise<AppServerCapabilities> | undefined;
  private disposePromise: Promise<void> | undefined;
  private initializedClient: AppServerSessionClient | undefined;
  private capabilities: AppServerCapabilities | undefined;
  private handlerDisposables: Disposable[] = [];
  private disposed = false;
  private securityProtocolFailure = false;

  public constructor(
    supervisor: AppServerSessionSupervisor,
    options: AppServerSessionOptions,
  );
  public constructor(
    supervisor: AppServerSessionSupervisor,
    extensionVersion: string,
  );
  public constructor(
    supervisor: AppServerSessionSupervisor,
    optionsOrVersion: AppServerSessionOptions | string,
  ) {
    this.supervisor = supervisor;
    const options = typeof optionsOrVersion === "string"
      ? { extensionVersion: optionsOrVersion }
      : optionsOrVersion;
    if (nonEmptyString(options.extensionVersion) === undefined) {
      throw new RangeError("extensionVersion must not be empty");
    }
    const ttlMs = options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("modelCacheTtlMs must be positive");
    }
    this.extensionVersion = options.extensionVersion;
    this.modelCache = new ModelCache(ttlMs, options.now);
    this.logger = options.logger;
  }

  public initialize(): Promise<AppServerCapabilities> {
    if (this.disposed) {
      return Promise.reject(new CodexError("cancelled", { action: "initializeCodex" }));
    }
    if (
      this.capabilities !== undefined
      && this.initializedClient !== undefined
      && this.initializedClient.isClosed !== true
    ) {
      return Promise.resolve(this.capabilities);
    }
    if (this.initializationPromise !== undefined) {
      return this.initializationPromise;
    }

    let operation!: Promise<AppServerCapabilities>;
    operation = this.initializeInternal().finally(() => {
      if (this.initializationPromise === operation) {
        this.initializationPromise = undefined;
      }
    });
    this.initializationPromise = operation;
    return operation;
  }

  public async restart(): Promise<AppServerCapabilities> {
    if (this.disposed) {
      throw new CodexError("cancelled", { action: "restartCodex" });
    }
    if (this.restartPromise !== undefined) {
      return this.restartPromise;
    }

    let operation!: Promise<AppServerCapabilities>;
    operation = this.restartInternal().finally(() => {
      if (this.restartPromise === operation) {
        this.restartPromise = undefined;
      }
    });
    this.restartPromise = operation;
    return operation;
  }

  public readAccount(): Promise<AppServerAccount> {
    return this.readAccountInternal();
  }

  public listModels(): Promise<readonly CodexModel[]> {
    return this.listModelsInternal();
  }

  public dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposeClientHandlers();
    this.modelCache.clear();
    const inFlightInitialization = this.initializationPromise;
    let operation!: Promise<void>;
    operation = (async (): Promise<void> => {
      await this.supervisor.stop();
      await inFlightInitialization?.catch(() => undefined);
    })();
    this.disposePromise = operation;
    return operation;
  }

  public get hasSecurityProtocolFailure(): boolean {
    return this.securityProtocolFailure;
  }

  private async initializeInternal(): Promise<AppServerCapabilities> {
    const client = await this.supervisor.start();
    this.disposeClientHandlers();
    let registrations: Disposable[] = [];
    let probingDynamicTools = false;
    try {
      registrations = this.registerSafetyHandlers(client);
      if (this.disposed) {
        throw new CodexError("cancelled", { action: "initializeCodex" });
      }
      const response = await client.request<unknown>("initialize", {
        clientInfo: {
          name: APP_SERVER_CLIENT_NAME,
          version: this.extensionVersion,
        },
        capabilities: { experimentalApi: true },
      });
      const capabilities = this.parseCapabilities(response);
      client.notify("initialized");
      probingDynamicTools = true;
      await client.request("thread/start", {
        ...APP_SERVER_THREAD_CONFIG,
        dynamicTools: [{
          name: "copilot_codex_provider_capability_probe",
          description: "A harmless capability probe that must never be executed.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        }],
      });
      probingDynamicTools = false;
      if (this.disposed) {
        throw new CodexError("cancelled", { action: "initializeCodex" });
      }
      this.initializedClient = client;
      const probedCapabilities: AppServerCapabilities = {
        ...capabilities,
        dynamicTools: true,
      };
      this.capabilities = probedCapabilities;
      this.handlerDisposables = registrations;
      this.supervisor.reportInitializationSuccess(client);
      return probedCapabilities;
    } catch (cause) {
      const failure = probingDynamicTools ? this.mapProbeFailure(cause) : this.mapInitializationFailure(cause);
      for (const registration of registrations) {
        registration.dispose();
      }
      if (this.initializedClient === client) {
        this.initializedClient = undefined;
        this.capabilities = undefined;
      }
      await this.supervisor.reportInitializationFailure(client, failure).catch(() => undefined);
      throw failure;
    }
  }

  private async restartInternal(): Promise<AppServerCapabilities> {
    const inFlightInitialization = this.initializationPromise;
    await inFlightInitialization?.catch(() => undefined);
    if (this.disposed) {
      throw new CodexError("cancelled", { action: "restartCodex" });
    }
    this.disposeClientHandlers();
    this.initializedClient = undefined;
    this.capabilities = undefined;
    this.securityProtocolFailure = false;
    this.modelCache.clear();
    await this.supervisor.restart();
    return this.initialize();
  }

  private async readAccountInternal(): Promise<AppServerAccount> {
    const client = await this.requireInitializedClient();
    const response = await client.request<unknown>("account/read", {});
    if (!isRecord(response) || !isRecord(response.account)) {
      throw protocolError("account/read", new Error("account/read result is malformed"));
    }
    const account = response.account;
    if (account.type !== "chatgpt" && account.type !== "personalAccessToken") {
      throw new CodexError("incompatible", {
        action: "upgradeCodex",
        cause: new Error("unsupported App Server account type"),
      });
    }
    const planType = nonEmptyString(account.planType);
    return {
      type: account.type,
      ...(planType === undefined ? {} : { planType }),
    };
  }

  private async listModelsInternal(): Promise<readonly CodexModel[]> {
    const client = await this.requireInitializedClient();
    return this.modelCache.get(async () => {
      if (client.isClosed === true) {
        throw new CodexError("process", { action: "listModels" });
      }
      const response = await client.request<unknown>("model/list", { includeHidden: false });
      return parseAppServerModels(response, (diagnostics) => this.recordModelDiagnostics(diagnostics));
    });
  }

  private async requireInitializedClient(): Promise<AppServerSessionClient> {
    await this.initialize();
    if (this.initializedClient === undefined) {
      throw new CodexError("process", { action: "startCodex" });
    }
    return this.initializedClient;
  }

  private parseCapabilities(payload: unknown): AppServerCapabilities {
    if (!isRecord(payload) || !isRecord(payload.capabilities)) {
      throw protocolError("initialize", new Error("initialize result is malformed"));
    }
    const capabilities = payload.capabilities;
    if (capabilities.experimentalApi !== true) {
      throw new CodexError("incompatible", {
        action: "upgradeCodex",
        cause: new Error("App Server lacks the required experimental capabilities"),
      });
    }
    if (
      "dynamicTools" in capabilities
      && capabilities.dynamicTools !== undefined
      && typeof capabilities.dynamicTools !== "boolean"
    ) {
      throw protocolError("initialize", new Error("initialize dynamicTools capability is malformed"));
    }
    const serverInfo = isRecord(payload.serverInfo) ? payload.serverInfo : undefined;
    const serverVersion = nonEmptyString(serverInfo?.version);
    return {
      dynamicTools: capabilities.dynamicTools === true,
      ...(serverVersion === undefined ? {} : { serverVersion }),
    };
  }

  private mapInitializationFailure(cause: unknown): CodexError {
    if (cause instanceof CodexError) {
      return cause;
    }
    return protocolError("initialize", cause);
  }

  private mapProbeFailure(cause: unknown): CodexError {
    if (
      cause instanceof CodexError
      && (cause.code === "cancelled" || cause.code === "timeout" || cause.code === "process")
    ) {
      return cause;
    }
    return new CodexError("incompatible", { action: "upgradeCodex", cause });
  }

  private registerSafetyHandlers(client: AppServerSessionClient): Disposable[] {
    const registrations: Disposable[] = [];
    const deny: JsonRpcServerRequestHandler = () => "deny";
    for (const method of APPROVAL_METHODS) {
      registrations.push(client.onServerRequest(method, deny));
    }

    const itemStartedHandler: JsonRpcServerRequestHandler = async (params) => {
      await this.handleItemStarted(client, params);
      return null;
    };
    registrations.push(client.onServerRequest("item/started", itemStartedHandler));
    if (client.onServerNotification !== undefined) {
      const itemStartedNotification: JsonRpcServerNotificationHandler = async (params) => {
        await this.handleItemStarted(client, params);
      };
      registrations.push(client.onServerNotification("item/started", itemStartedNotification));
    }
    return registrations;
  }

  private async handleItemStarted(
    client: AppServerSessionClient,
    params: unknown,
  ): Promise<void> {
    const record: ItemStartedParams = isRecord(params) ? params as ItemStartedParams : {};
    const item = isRecord(record.item) ? record.item : undefined;
    const itemType = nonEmptyString(item?.type)
      ?? nonEmptyString(record.itemType)
      ?? nonEmptyString(record.type);
    if (itemType !== "commandExecution" && itemType !== "fileChange") {
      return;
    }

    this.securityProtocolFailure = true;
    const interruptParams = {
      ...(nonEmptyString(record.threadId) === undefined
        ? {}
        : { threadId: nonEmptyString(record.threadId) }),
      ...(nonEmptyString(record.turnId) === undefined
        ? {}
        : { turnId: nonEmptyString(record.turnId) }),
    };
    await client.request("turn/interrupt", interruptParams).catch(() => undefined);
  }

  private recordModelDiagnostics(diagnostics: AppServerModelDiagnostics): void {
    this.logger?.event("appServer.modelOmitted", {
      missingFields: diagnostics.missingFields,
    });
  }

  private disposeClientHandlers(): void {
    for (const registration of this.handlerDisposables) {
      registration.dispose();
    }
    this.handlerDisposables = [];
  }
}
