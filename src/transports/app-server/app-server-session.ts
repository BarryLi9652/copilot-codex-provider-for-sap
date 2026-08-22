import { CodexError } from "../../core/errors.js";
import { ModelCache } from "../../core/model-cache.js";
import type { CodexModel, JsonObject } from "../../core/types.js";
import { SafeLogger } from "../../security/logger.js";
import {
  type Disposable,
  type JsonRpcId,
  type JsonRpcServerNotificationHandler,
  type JsonRpcServerRequestHandler,
  JsonRpcRemoteError,
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

const TRANSPORT_NOTIFICATION_METHODS: readonly AppServerNotificationMethod[] = [
  "turn/started",
  "item/agentMessage/delta",
  "turn/usage",
  "turn/completed",
  "turn/failed",
  "turn/error",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const turnKey = (threadId: string, turnId: string): string => `${threadId}\u0000${turnId}`;

interface Correlation {
  readonly threadId: string;
  readonly turnId: string;
}

const readCorrelation = (payload: unknown): Correlation | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const threadId = nonEmptyString(payload.threadId);
  const nestedTurn = isRecord(payload.turn) ? payload.turn : undefined;
  const turnId = nonEmptyString(payload.turnId) ?? nonEmptyString(nestedTurn?.id);
  return threadId === undefined || turnId === undefined
    ? undefined
    : { threadId, turnId };
};

const readThreadId = (payload: unknown): string => {
  if (!isRecord(payload) || !isRecord(payload.thread) || nonEmptyString(payload.thread.id) === undefined) {
    throw protocolError("thread/start");
  }
  return payload.thread.id as string;
};

const readTurnId = (payload: unknown): string => {
  if (!isRecord(payload) || !isRecord(payload.turn) || nonEmptyString(payload.turn.id) === undefined) {
    throw protocolError("turn/start");
  }
  return payload.turn.id as string;
};

export interface AppServerCapabilities {
  dynamicTools: boolean;
  serverVersion?: string;
}

export interface AppServerAccount {
  type: "chatgpt" | "personalAccessToken";
  planType?: string;
}

export type AppServerUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export interface AppServerDynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonObject;
  deferLoading: false;
}

export interface AppServerTurnStartParams {
  threadId: string;
  modelId: string;
  input: readonly AppServerUserInput[];
}

export type AppServerNotificationMethod =
  | "turn/started"
  | "item/agentMessage/delta"
  | "turn/usage"
  | "turn/completed"
  | "turn/failed"
  | "turn/error";

export interface AppServerSecurityFailure {
  threadId: string;
  turnId: string;
  generation: number;
  leaseId: string;
  interruptIssued?: boolean;
}

export interface AppServerSessionClient {
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): void;
  onServerRequest(method: string, handler: JsonRpcServerRequestHandler): Disposable;
  onServerNotification: (
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ) => Disposable;
  onDidTerminate?(handler: (error: CodexError) => void): Disposable;
  readonly isClosed?: boolean;
}

export interface AppServerTransportLease {
  readonly generation: number;
  readonly leaseId: string;
  readonly capabilities: AppServerCapabilities;
  startThread(
    dynamicTools: readonly AppServerDynamicTool[],
    signal?: AbortSignal,
  ): Promise<{ threadId: string }>;
  startTurn(
    params: AppServerTurnStartParams,
    signal?: AbortSignal,
  ): Promise<{ turnId: string }>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
  onNotification(
    method: AppServerNotificationMethod,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable;
  onToolCall(handler: JsonRpcServerRequestHandler): Disposable;
  onSecurityFailure(handler: (failure: AppServerSecurityFailure) => void): Disposable;
  onProcessExit(handler: (error: CodexError) => void): Disposable;
  release(): void;
}

export interface AppServerTransportSession {
  acquireTransportLease(): Promise<AppServerTransportLease>;
  listModels(): Promise<readonly CodexModel[]>;
  dispose(): Promise<void>;
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
  modelCache?: ModelCache;
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

interface BufferedTransportNotification {
  readonly method: AppServerNotificationMethod;
  readonly params: unknown;
}

interface BufferedTransportToolCall {
  readonly params: unknown;
  readonly id: JsonRpcId;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

interface TransportLeaseRecord {
  readonly generation: number;
  readonly leaseId: string;
  readonly client: AppServerSessionClient;
  readonly capabilities: AppServerCapabilities;
  readonly threadIds: Set<string>;
  readonly turnIds: Set<string>;
  readonly pendingTurnThreads: Set<string>;
  readonly preResponseNotifications: Map<string, BufferedTransportNotification[]>;
  readonly preResponseToolCalls: Map<string, BufferedTransportToolCall[]>;
  readonly notificationHandlers: Map<AppServerNotificationMethod, Set<JsonRpcServerNotificationHandler>>;
  readonly toolHandlers: Set<JsonRpcServerRequestHandler>;
  readonly securityHandlers: Set<(failure: AppServerSecurityFailure) => void>;
  readonly processExitHandlers: Set<(error: CodexError) => void>;
  released: boolean;
  processExitNotified: boolean;
}

export class AppServerSession {
  private readonly supervisor: AppServerSessionSupervisor;
  private readonly extensionVersion: string;
  private readonly modelCache: ModelCache;
  private readonly logger: SafeLogger | undefined;
  private initializationPromise: Promise<AppServerCapabilities> | undefined;
  private restartPromise: Promise<AppServerCapabilities> | undefined;
  private disposePromise: Promise<void> | undefined;
  private nextGeneration = 1;
  private nextLeaseId = 1;
  private initializedClient: AppServerSessionClient | undefined;
  private initializedGeneration: number | undefined;
  private capabilities: AppServerCapabilities | undefined;
  private modelCacheClient: AppServerSessionClient | undefined;
  private modelCacheGeneration: number | undefined;
  private incompatibleFailure: CodexError | undefined;
  private handlerDisposables: Disposable[] = [];
  private readonly transportLeases = new Set<TransportLeaseRecord>();
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
    this.modelCache = options.modelCache ?? new ModelCache(ttlMs, options.now);
    this.logger = options.logger;
  }

  public initialize(): Promise<AppServerCapabilities> {
    if (this.disposed) {
      return Promise.reject(new CodexError("cancelled", { action: "initializeCodex" }));
    }
    if (this.restartPromise !== undefined) {
      return this.restartPromise;
    }
    if (this.incompatibleFailure !== undefined) {
      return Promise.reject(this.incompatibleFailure);
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
    if (this.initializedClient?.isClosed === true) {
      this.clearInitializedState();
    }

    let operation!: Promise<AppServerCapabilities>;
    operation = this.initializeFromStart().finally(() => {
      if (this.initializationPromise === operation) {
        this.initializationPromise = undefined;
      }
    });
    this.initializationPromise = operation;
    return operation;
  }

  public restart(): Promise<AppServerCapabilities> {
    if (this.disposed) {
      return Promise.reject(new CodexError("cancelled", { action: "restartCodex" }));
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

  public async acquireTransportLease(): Promise<AppServerTransportLease> {
    const capabilities = await this.initialize();
    const client = this.initializedClient;
    const generation = this.initializedGeneration;
    if (client === undefined || generation === undefined || client.isClosed === true) {
      throw new CodexError("process", { action: "acquireAppServerLease" });
    }
    const record: TransportLeaseRecord = {
      generation,
      leaseId: `app-server-lease-${this.nextLeaseId++}`,
      client,
      capabilities,
      threadIds: new Set(),
      turnIds: new Set(),
      pendingTurnThreads: new Set(),
      preResponseNotifications: new Map(),
      preResponseToolCalls: new Map(),
      notificationHandlers: new Map(),
      toolHandlers: new Set(),
      securityHandlers: new Set(),
      processExitHandlers: new Set(),
      released: false,
      processExitNotified: false,
    };
    this.transportLeases.add(record);
    return this.createTransportLease(record);
  }

  private createTransportLease(record: TransportLeaseRecord): AppServerTransportLease {
    return {
      generation: record.generation,
      leaseId: record.leaseId,
      capabilities: record.capabilities,
      startThread: async (dynamicTools, signal) => {
        this.assertLeaseForStart(record);
        if (!record.capabilities.dynamicTools) {
          throw new CodexError("incompatible", { action: "upgradeCodex" });
        }
        const response = await record.client.request<unknown>("thread/start", {
          ...APP_SERVER_THREAD_CONFIG,
          dynamicTools: dynamicTools.map((tool) => ({
            type: tool.type,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            deferLoading: tool.deferLoading,
          })),
        }, signal);
        this.assertLeaseForStart(record);
        const threadId = readThreadId(response);
        record.threadIds.add(threadId);
        return { threadId };
      },
      startTurn: async (params, signal) => {
        this.assertLeaseForStart(record);
        this.assertLeaseThread(record, params.threadId);
        record.pendingTurnThreads.add(params.threadId);
        try {
          const response = await record.client.request<unknown>("turn/start", {
            threadId: params.threadId,
            model: params.modelId,
            input: params.input,
          }, signal);
          this.assertLeaseForStart(record);
          const turnId = readTurnId(response);
          record.pendingTurnThreads.delete(params.threadId);
          record.turnIds.add(turnKey(params.threadId, turnId));
          this.flushPreResponseEvents(record, params.threadId, turnId);
          return { turnId };
        } catch (cause) {
          record.pendingTurnThreads.delete(params.threadId);
          this.rejectPreResponseToolCalls(record, params.threadId, cause);
          throw cause;
        }
      },
      interrupt: async (threadId, turnId) => {
        this.assertLeaseForCleanup(record);
        this.assertLeaseTurn(record, threadId, turnId);
        await record.client.request("turn/interrupt", { threadId, turnId });
      },
      unsubscribe: async (threadId) => {
        this.assertLeaseForCleanup(record);
        this.rejectPreResponseToolCalls(
          record,
          threadId,
          new CodexError("cancelled", { action: "appServerLease" }),
        );
        record.pendingTurnThreads.delete(threadId);
        this.assertLeaseThread(record, threadId);
        await record.client.request("thread/unsubscribe", { threadId });
        record.threadIds.delete(threadId);
        for (const key of [...record.turnIds]) {
          if (key.startsWith(`${threadId}\u0000`)) {
            record.turnIds.delete(key);
          }
        }
      },
      onNotification: (method, handler) => {
        this.assertLeaseForStart(record);
        const handlers = record.notificationHandlers.get(method) ?? new Set();
        handlers.add(handler);
        record.notificationHandlers.set(method, handlers);
        return {
          dispose: (): void => {
            handlers.delete(handler);
          },
        };
      },
      onToolCall: (handler) => {
        this.assertLeaseForStart(record);
        record.toolHandlers.add(handler);
        return { dispose: (): void => { record.toolHandlers.delete(handler); } };
      },
      onSecurityFailure: (handler) => {
        this.assertLeaseForStart(record);
        record.securityHandlers.add(handler);
        return { dispose: (): void => { record.securityHandlers.delete(handler); } };
      },
      onProcessExit: (handler) => {
        this.assertLeaseForStart(record);
        record.processExitHandlers.add(handler);
        return { dispose: (): void => { record.processExitHandlers.delete(handler); } };
      },
      release: (): void => {
        this.releaseTransportLease(record);
      },
    };
  }

  private assertLeaseForStart(record: TransportLeaseRecord): void {
    if (record.released || this.disposed) {
      throw new CodexError("cancelled", { action: "appServerLease" });
    }
    if (
      record.client.isClosed === true
      || this.initializedClient !== record.client
      || this.initializedGeneration !== record.generation
    ) {
      throw new CodexError("process", { action: "appServerLease" });
    }
  }

  private assertLeaseForCleanup(record: TransportLeaseRecord): void {
    if (record.released) {
      throw new CodexError("cancelled", { action: "appServerLease" });
    }
  }

  private assertLeaseThread(record: TransportLeaseRecord, threadId: string): void {
    if (!record.threadIds.has(threadId)) {
      throw protocolError("appServerThread");
    }
  }

  private assertLeaseTurn(record: TransportLeaseRecord, threadId: string, turnId: string): void {
    if (!record.turnIds.has(turnKey(threadId, turnId))) {
      throw protocolError("appServerTurn");
    }
  }

  private releaseTransportLease(record: TransportLeaseRecord): void {
    if (record.released) {
      return;
    }
    record.released = true;
    record.notificationHandlers.clear();
    record.toolHandlers.clear();
    record.securityHandlers.clear();
    record.processExitHandlers.clear();
    record.threadIds.clear();
    record.turnIds.clear();
    this.rejectPreResponseToolCalls(
      record,
      undefined,
      new CodexError("cancelled", { action: "appServerLease" }),
    );
    record.pendingTurnThreads.clear();
    record.preResponseNotifications.clear();
    this.transportLeases.delete(record);
  }

  public dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    const inFlightRestart = this.restartPromise;
    const inFlightInitialization = this.initializationPromise;
    this.disposed = true;
    this.clearInitializedState();
    let operation!: Promise<void>;
    operation = (async (): Promise<void> => {
      let stopFailure: unknown;
      try {
        await this.supervisor.stop();
      } catch (cause) {
        stopFailure = cause;
      }
      await inFlightRestart?.catch(() => undefined);
      await inFlightInitialization?.catch(() => undefined);
      if (stopFailure !== undefined) {
        throw stopFailure;
      }
    })();
    this.disposePromise = operation;
    return operation;
  }

  public get hasSecurityProtocolFailure(): boolean {
    return this.securityProtocolFailure;
  }

  public get currentCapabilities(): AppServerCapabilities | undefined {
    return this.capabilities === undefined ? undefined : { ...this.capabilities };
  }

  private async initializeFromStart(): Promise<AppServerCapabilities> {
    const client = await this.supervisor.start();
    this.throwIfDisposed("initializeCodex");
    return this.initializeClient(client, this.nextGeneration++);
  }

  private async initializeClient(
    client: AppServerSessionClient,
    generation: number,
  ): Promise<AppServerCapabilities> {
    this.disposeClientHandlers();
    let registrations: Disposable[] = [];
    let probingDynamicTools = false;
    try {
      this.throwIfDisposed("initializeCodex");
      if (client.isClosed === true) {
        throw new CodexError("process", { action: "initializeCodex" });
      }
      registrations = this.registerSafetyHandlers(client);
      registrations.push(...this.registerTransportHandlers(client, generation));
      this.handlerDisposables = registrations;
      this.throwIfDisposed("initializeCodex");
      const response = await client.request<unknown>("initialize", {
        clientInfo: {
          name: APP_SERVER_CLIENT_NAME,
          version: this.extensionVersion,
        },
        capabilities: { experimentalApi: true },
      });
      this.throwIfDisposed("initializeCodex");
      const capabilities = this.parseCapabilities(response);
      client.notify("initialized");
      this.throwIfDisposed("initializeCodex");
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
      this.throwIfDisposed("initializeCodex");
      this.initializedClient = client;
      this.initializedGeneration = generation;
      const probedCapabilities: AppServerCapabilities = {
        ...capabilities,
        dynamicTools: true,
      };
      this.capabilities = probedCapabilities;
      this.modelCache.clear();
      this.modelCacheClient = client;
      this.modelCacheGeneration = generation;
      this.supervisor.reportInitializationSuccess(client);
      return probedCapabilities;
    } catch (cause) {
      const failure = probingDynamicTools ? this.mapProbeFailure(cause) : this.mapInitializationFailure(cause);
      this.disposeClientHandlers();
      if (this.initializedClient === client) {
        this.clearInitializedState();
      }
      if (failure.code === "incompatible") {
        this.incompatibleFailure = failure;
        this.clearInitializedState();
      }
      await this.supervisor.reportInitializationFailure(client, failure).catch(() => undefined);
      throw failure;
    }
  }

  private async restartInternal(): Promise<AppServerCapabilities> {
    const inFlightInitialization = this.initializationPromise;
    await inFlightInitialization?.catch(() => undefined);
    this.throwIfDisposed("restartCodex");
    this.clearInitializedState();
    this.incompatibleFailure = undefined;
    const client = await this.supervisor.restart();
    this.throwIfDisposed("restartCodex");
    return this.initializeClient(client, this.nextGeneration++);
  }

  private async readAccountInternal(): Promise<AppServerAccount> {
    const { client, generation } = await this.requireInitializedClient();
    this.assertCurrentClient(client, generation, "account/read");
    const response = await client.request<unknown>("account/read", {});
    this.assertCurrentClient(client, generation, "account/read");
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
    const { client, generation } = await this.requireInitializedClient();
    this.assertCurrentClient(client, generation, "listModels");
    this.prepareModelCache(client, generation);
    const models = await this.modelCache.get(async () => {
      this.assertCurrentClient(client, generation, "listModels");
      const response = await client.request<unknown>("model/list", { includeHidden: false });
      this.assertCurrentClient(client, generation, "listModels");
      return parseAppServerModels(
        response,
        { dynamicToolsAvailable: this.capabilities?.dynamicTools === true },
        (diagnostics) => this.recordModelDiagnostics(diagnostics),
      );
    });
    this.assertCurrentClient(client, generation, "listModels");
    return models;
  }

  private async requireInitializedClient(): Promise<{
    client: AppServerSessionClient;
    generation: number;
  }> {
    await this.initialize();
    this.throwIfDisposed("startCodex");
    if (this.initializedClient === undefined || this.initializedGeneration === undefined) {
      throw new CodexError("process", { action: "startCodex" });
    }
    return {
      client: this.initializedClient,
      generation: this.initializedGeneration,
    };
  }

  private throwIfDisposed(action: string): void {
    if (this.disposed) {
      throw new CodexError("cancelled", { action });
    }
  }

  private clearInitializedState(): void {
    if (this.initializedClient !== undefined && this.initializedGeneration !== undefined) {
      this.notifyTransportProcessExit(
        this.initializedClient,
        this.initializedGeneration,
        new CodexError("process", { action: "appServerExit" }),
      );
    }
    this.disposeClientHandlers();
    this.initializedClient = undefined;
    this.initializedGeneration = undefined;
    this.capabilities = undefined;
    this.securityProtocolFailure = false;
    this.modelCache.clear();
    this.modelCacheClient = undefined;
    this.modelCacheGeneration = undefined;
  }

  private prepareModelCache(client: AppServerSessionClient, generation: number): void {
    if (this.modelCacheClient === client && this.modelCacheGeneration === generation) {
      return;
    }
    this.modelCache.clear();
    this.modelCacheClient = client;
    this.modelCacheGeneration = generation;
  }

  private invalidateModelCache(client: AppServerSessionClient, generation: number): void {
    if (this.modelCacheClient !== client || this.modelCacheGeneration !== generation) {
      return;
    }
    this.modelCache.clear();
    this.modelCacheClient = undefined;
    this.modelCacheGeneration = undefined;
  }

  private assertCurrentClient(
    client: AppServerSessionClient,
    generation: number,
    action: string,
  ): void {
    this.throwIfDisposed(action);
    if (
      this.initializedClient === client
      && this.initializedGeneration === generation
      && client.isClosed !== true
    ) {
      return;
    }
    if (this.initializedClient === client && client.isClosed === true) {
      this.clearInitializedState();
    } else {
      this.invalidateModelCache(client, generation);
    }
    throw new CodexError("process", { action });
  }

  private parseCapabilities(payload: unknown): AppServerCapabilities {
    if (!isRecord(payload)) {
      throw protocolError("initialize", new Error("initialize result is malformed"));
    }
    const capabilities = payload.capabilities;
    if (capabilities !== undefined && !isRecord(capabilities)) {
      throw protocolError("initialize", new Error("initialize capabilities are malformed"));
    }
    const currentShape = nonEmptyString(payload.userAgent) !== undefined;
    if (!currentShape && capabilities === undefined) {
      throw protocolError("initialize", new Error("initialize result is malformed"));
    }
    if (isRecord(capabilities) && capabilities.experimentalApi === false) {
      throw new CodexError("incompatible", {
        action: "upgradeCodex",
        cause: new Error("App Server lacks the required experimental capabilities"),
      });
    }
    if (
      isRecord(capabilities)
      && "dynamicTools" in capabilities
      && capabilities.dynamicTools !== undefined
      && typeof capabilities.dynamicTools !== "boolean"
    ) {
      throw protocolError("initialize", new Error("initialize dynamicTools capability is malformed"));
    }
    const serverInfo = isRecord(payload.serverInfo) ? payload.serverInfo : undefined;
    const serverVersion = nonEmptyString(serverInfo?.version);
    return {
      dynamicTools: isRecord(capabilities) && capabilities.dynamicTools === true,
      ...(serverVersion === undefined ? {} : { serverVersion }),
    };
  }

  private mapInitializationFailure(cause: unknown): CodexError {
    if (cause instanceof CodexError) {
      if (this.isCapabilityUnsupportedFailure(cause)) {
        return this.incompatibleCapabilityError();
      }
      return cause;
    }
    return protocolError("initialize", cause);
  }

  private mapProbeFailure(cause: unknown): CodexError {
    if (cause instanceof CodexError) {
      if (this.isCapabilityUnsupportedFailure(cause)) {
        return this.incompatibleCapabilityError();
      }
      return cause;
    }
    return protocolError("thread/start", cause);
  }

  private incompatibleCapabilityError(): CodexError {
    return new CodexError("incompatible", {
      action: "upgradeCodex",
      cause: new Error("required App Server capability is unavailable"),
    });
  }

  private registerTransportHandlers(
    client: AppServerSessionClient,
    generation: number,
  ): Disposable[] {
    const registrations: Disposable[] = [];
    for (const method of TRANSPORT_NOTIFICATION_METHODS) {
      registrations.push(client.onServerNotification(method, (params) => {
        this.dispatchTransportNotification(client, generation, method, params);
      }));
    }
    registrations.push(client.onServerRequest("item/tool/call", (params, id) =>
      this.dispatchTransportToolCall(client, generation, params, id)));
    if (client.onDidTerminate !== undefined) {
      registrations.push(client.onDidTerminate((error) => {
        this.notifyTransportProcessExit(client, generation, error);
      }));
    }
    return registrations;
  }

  private dispatchTransportNotification(
    client: AppServerSessionClient,
    generation: number,
    method: AppServerNotificationMethod,
    params: unknown,
  ): void {
    const correlation = readCorrelation(params);
    if (correlation === undefined) {
      return;
    }
    const candidates = [...this.transportLeases].filter((lease) =>
      !lease.released
      && lease.client === client
      && lease.generation === generation
      && lease.threadIds.has(correlation.threadId));
    const active = candidates.filter((lease) =>
      lease.turnIds.has(turnKey(correlation.threadId, correlation.turnId)));
    if (active.length === 1) {
      for (const handler of active[0]?.notificationHandlers.get(method) ?? []) {
        void Promise.resolve(handler(params)).catch(() => undefined);
      }
      return;
    }
    if (active.length > 1) {
      return;
    }
    const pending = candidates.filter((lease) =>
      lease.pendingTurnThreads.has(correlation.threadId));
    if (pending.length !== 1) {
      return;
    }
    const lease = pending[0];
    if (lease === undefined) {
      return;
    }
    const key = turnKey(correlation.threadId, correlation.turnId);
    const buffered = lease.preResponseNotifications.get(key) ?? [];
    buffered.push({ method, params });
    lease.preResponseNotifications.set(key, buffered);
  }

  private dispatchTransportToolCall(
    client: AppServerSessionClient,
    generation: number,
    params: unknown,
    id: JsonRpcId,
  ): Promise<unknown> {
    const correlation = readCorrelation(params);
    if (correlation === undefined) {
      return Promise.reject(protocolError("item/tool/call"));
    }
    const candidates = [...this.transportLeases].filter((lease) =>
      !lease.released
      && lease.client === client
      && lease.generation === generation
      && lease.threadIds.has(correlation.threadId));
    const matching = candidates.filter((lease) =>
      lease.turnIds.has(turnKey(correlation.threadId, correlation.turnId)));
    if (matching.length > 1) {
      return Promise.reject(protocolError("item/tool/call"));
    }
    if (matching.length === 1) {
      const handlers = [...(matching[0]?.toolHandlers ?? [])];
      if (handlers.length !== 1) {
        return Promise.reject(protocolError("item/tool/call"));
      }
      return Promise.resolve(handlers[0]?.(params, id));
    }
    const pending = candidates.filter((lease) =>
      lease.pendingTurnThreads.has(correlation.threadId)
      && lease.toolHandlers.size > 0);
    if (pending.length !== 1) {
      return Promise.reject(protocolError("item/tool/call"));
    }
    const lease = pending[0];
    if (lease === undefined) {
      return Promise.reject(protocolError("item/tool/call"));
    }
    const key = turnKey(correlation.threadId, correlation.turnId);
    return new Promise<unknown>((resolve, reject) => {
      const buffered = lease.preResponseToolCalls.get(key) ?? [];
      buffered.push({ params, id, resolve, reject });
      lease.preResponseToolCalls.set(key, buffered);
    });
  }

  private flushPreResponseEvents(
    record: TransportLeaseRecord,
    threadId: string,
    turnId: string,
  ): void {
    if (record.released) {
      return;
    }
    const key = turnKey(threadId, turnId);
    const notifications = record.preResponseNotifications.get(key) ?? [];
    const toolCalls = record.preResponseToolCalls.get(key) ?? [];
    this.dropPreResponseEventsForOtherTurns(record, threadId, key);
    record.preResponseNotifications.delete(key);
    record.preResponseToolCalls.delete(key);

    for (const notification of notifications) {
      for (const handler of record.notificationHandlers.get(notification.method) ?? []) {
        void Promise.resolve(handler(notification.params)).catch(() => undefined);
      }
    }

    const handlers = [...record.toolHandlers];
    if (handlers.length !== 1) {
      const failure = protocolError("item/tool/call");
      for (const toolCall of toolCalls) {
        toolCall.reject(failure);
      }
      return;
    }
    const handler = handlers[0];
    if (handler === undefined) {
      return;
    }
    for (const toolCall of toolCalls) {
      void Promise.resolve(handler(toolCall.params, toolCall.id))
        .then(toolCall.resolve, toolCall.reject);
    }
  }

  private rejectPreResponseToolCalls(
    record: TransportLeaseRecord,
    threadId: string | undefined,
    cause: unknown,
  ): void {
    for (const [key, toolCalls] of record.preResponseToolCalls) {
      if (threadId !== undefined && !key.startsWith(`${threadId}\u0000`)) {
        continue;
      }
      record.preResponseToolCalls.delete(key);
      for (const toolCall of toolCalls) {
        toolCall.reject(cause);
      }
    }
    if (threadId === undefined) {
      record.preResponseNotifications.clear();
      return;
    }
    for (const key of record.preResponseNotifications.keys()) {
      if (key.startsWith(`${threadId}\u0000`)) {
        record.preResponseNotifications.delete(key);
      }
    }
  }

  private dropPreResponseEventsForOtherTurns(
    record: TransportLeaseRecord,
    threadId: string,
    retainedKey: string,
  ): void {
    for (const key of record.preResponseNotifications.keys()) {
      if (key !== retainedKey && key.startsWith(`${threadId}\u0000`)) {
        record.preResponseNotifications.delete(key);
      }
    }
    for (const key of record.preResponseToolCalls.keys()) {
      if (key !== retainedKey && key.startsWith(`${threadId}\u0000`)) {
        const toolCalls = record.preResponseToolCalls.get(key) ?? [];
        record.preResponseToolCalls.delete(key);
        const failure = protocolError("item/tool/call");
        for (const toolCall of toolCalls) {
          toolCall.reject(failure);
        }
      }
    }
  }

  private notifyTransportProcessExit(
    client: AppServerSessionClient,
    generation: number,
    error: CodexError,
  ): void {
    for (const lease of this.transportLeases) {
      if (
        lease.released
        || lease.processExitNotified
        || lease.client !== client
        || lease.generation !== generation
      ) {
        continue;
      }
      lease.processExitNotified = true;
      for (const handler of lease.processExitHandlers) {
        try {
          handler(error);
        } catch {
          // A process-exit observer must not prevent other leases from closing.
        }
      }
    }
  }

  private isCapabilityUnsupportedFailure(cause: CodexError): boolean {
    if (cause.code !== "protocol") {
      return false;
    }
    const remote = cause.cause instanceof JsonRpcRemoteError
      ? { code: cause.cause.rpcCode, message: cause.cause.rpcMessage }
      : isRecord(cause.cause)
        && typeof cause.cause.code === "number"
        && typeof cause.cause.message === "string"
        ? { code: cause.cause.code, message: cause.cause.message }
        : undefined;
    if (remote === undefined || (remote.code !== -32601 && remote.code !== -32602)) {
      return false;
    }
    if (/(dynamic[\s_-]*tools?|experimental[\s_-]*api)/i.test(remote.message)) {
      return true;
    }
    return cause.action === "thread/start"
      && remote.code === -32601
      && /(method|procedure|request).*(not found|unknown|unsupported|unavailable)/i.test(remote.message);
  }

  private registerSafetyHandlers(client: AppServerSessionClient): Disposable[] {
    if (typeof client.onServerNotification !== "function") {
      throw this.incompatibleCapabilityError();
    }
    const registrations: Disposable[] = [];
    try {
      const deny: JsonRpcServerRequestHandler = () => "deny";
      for (const method of APPROVAL_METHODS) {
        registrations.push(client.onServerRequest(method, deny));
      }

      const itemStartedHandler: JsonRpcServerRequestHandler = async (params) => {
        await this.handleItemStarted(client, params);
        return null;
      };
      registrations.push(client.onServerRequest("item/started", itemStartedHandler));
      const itemStartedNotification: JsonRpcServerNotificationHandler = async (params) => {
        await this.handleItemStarted(client, params);
      };
      registrations.push(client.onServerNotification("item/started", itemStartedNotification));
      return registrations;
    } catch (cause) {
      for (const registration of registrations) {
        registration.dispose();
      }
      throw cause;
    }
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
    const threadId = nonEmptyString(record.threadId);
    const turnId = nonEmptyString(record.turnId);
    const interruptParams = {
      ...(threadId === undefined
        ? {}
        : { threadId }),
      ...(turnId === undefined
        ? {}
        : { turnId }),
    };
    await client.request("turn/interrupt", interruptParams).catch(() => undefined);
    if (threadId === undefined || turnId === undefined) {
      return;
    }
    for (const lease of this.transportLeases) {
      if (
        lease.released
        || lease.client !== client
        || !lease.threadIds.has(threadId)
        || !lease.turnIds.has(turnKey(threadId, turnId))
      ) {
        continue;
      }
      const failure: AppServerSecurityFailure = {
        threadId,
        turnId,
        generation: lease.generation,
        leaseId: lease.leaseId,
        interruptIssued: true,
      };
      for (const handler of lease.securityHandlers) {
        handler(failure);
      }
    }
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
