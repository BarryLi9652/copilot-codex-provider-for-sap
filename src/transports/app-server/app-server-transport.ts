import { CodexError } from "../../core/errors.js";
import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "../../core/types.js";
import { classifySapTools } from "../../sap/tool-capabilities.js";
import type {
  AppServerDynamicTool,
  AppServerNotificationMethod,
  AppServerSecurityFailure,
  AppServerTransportLease,
  AppServerTransportSession,
  AppServerTurnStartParams,
} from "./app-server-session.js";
import {
  type Disposable,
  type JsonRpcId,
  type JsonRpcServerNotificationHandler,
  type JsonRpcServerRequestHandler,
  protocolError,
} from "./protocol.js";
import { serializeTranscript } from "./transcript.js";
import { buildAppServerTurnInstructions } from "./turn-policy.js";
import {
  ToolContinuationRegistry,
  type ToolContinuationIdentity,
  type ToolContinuationResult,
} from "./tool-continuations.js";

export type {
  AppServerDynamicTool,
  AppServerNotificationMethod,
  AppServerSecurityFailure,
  AppServerTransportLease,
  AppServerTransportSession,
  AppServerTurnStartParams,
} from "./app-server-session.js";

export interface AppServerTransportOptions {
  supportsImages?: boolean;
  failedCallTtlMs?: number;
  logger?: AppServerTransportLogger;
}

export interface AppServerTransportLogger {
  event(name: string, metadata?: Record<string, unknown>): void;
}

type QueueItem = { kind: "event"; event: TransportEvent } | { kind: "tool" };

interface Correlation {
  readonly threadId: string;
  readonly turnId: string;
}

interface PreResponseNotification {
  readonly method: AppServerNotificationMethod;
  readonly params: unknown;
}

interface PreResponseToolCall {
  readonly params: unknown;
  readonly rpcId: JsonRpcId;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface TurnState {
  readonly generation: number;
  readonly leaseId: string;
  readonly lease: AppServerTransportLease;
  readonly threadId: string;
  turnId: string;
  readonly supportsImages: boolean;
  readonly requireToolCall: boolean;
  readonly toolNames: ReadonlySet<string>;
  readonly queue: AsyncQueue<QueueItem>;
  readonly registrations: Disposable[];
  readonly callIds: Set<string>;
  readonly callNames: Map<string, string>;
  /**
   * Last-seen cumulative thread token usage from
   * `thread/tokenUsage/updated`. The notification reports thread totals
   * (cumulative across continuation turns), so usage events are emitted as
   * deltas against this snapshot to avoid double counting.
   */
  lastThreadUsage: { inputTokens: number; cachedTokens: number; outputTokens: number } | undefined;
  /**
   * True once `thread/tokenUsage/updated` has been observed for this state.
   * Used to skip the legacy `turn/usage` notification so a codex version
   * that emits both never double counts.
   */
  threadUsageSeen: boolean;
  readonly surfacedCallIds: Set<string>;
  readonly receivedCallIds: Set<string>;
  readonly preResponseNotifications: PreResponseNotification[];
  readonly preResponseToolCalls: PreResponseToolCall[];
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  terminal: boolean;
  failure: Error | undefined;
  cleanupStarted: boolean;
  cleaned: boolean;
  consumerActive: boolean;
  keepAlive: boolean;
  readonly streamedAgentText: Map<string, string>;
  cleanupPromise: Promise<Error | undefined> | undefined;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CLEANUP_TIMEOUT_MS = 250;
const DEFAULT_FAILED_CALL_TTL_MS = 300_000;
const LEGACY_AGENT_MESSAGE_ID = "\u0000legacy-agent-message";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readCorrelation = (params: unknown): Correlation | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }
  const threadId = stringValue(params.threadId);
  const nestedTurn = isRecord(params.turn) ? params.turn : undefined;
  const turnId = stringValue(params.turnId) ?? stringValue(nestedTurn?.id);
  return threadId === undefined || turnId === undefined
    ? undefined
    : { threadId, turnId };
};

interface FinalAgentMessage {
  readonly id: string | undefined;
  readonly text: string;
}

const readFinalAgentMessage = (
  turn: Record<string, unknown> | undefined,
): FinalAgentMessage | undefined => {
  if (!Array.isArray(turn?.items)) {
    return undefined;
  }
  let lastMessage: FinalAgentMessage | undefined;
  let finalMessage: FinalAgentMessage | undefined;
  for (const value of turn.items) {
    if (!isRecord(value) || value.type !== "agentMessage") {
      continue;
    }
    const text = stringValue(value.text);
    if (text === undefined) {
      continue;
    }
    const message = { id: stringValue(value.id), text };
    lastMessage = message;
    if (value.phase === "final_answer") {
      finalMessage = message;
    }
  }
  return finalMessage ?? lastMessage;
};

const chainKey = (
  threadId: string,
  turnId: string,
  generation: number,
  leaseId: string,
): string => JSON.stringify([generation, leaseId, threadId, turnId]);

const callKey = (callId: string, generation: number, leaseId: string): string =>
  JSON.stringify([generation, leaseId, callId]);

const stateIdentity = (state: TurnState): ToolContinuationIdentity => ({
  generation: state.generation,
  leaseId: state.leaseId,
});

const cancellationError = (): CodexError => new CodexError("cancelled");

const asError = (error: unknown, fallback: CodexError): Error =>
  error instanceof Error ? error : fallback;

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }> = [];
  private closed = false;
  private failure: Error | undefined;

  public push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
      return;
    }
    this.detach(waiter);
    waiter.resolve({ done: false, value });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        break;
      }
      this.detach(waiter);
      if (this.failure === undefined) {
        waiter.resolve({ done: true, value: undefined as never });
      } else {
        waiter.reject(this.failure);
      }
    }
  }

  public fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    this.values.length = 0;
    this.close();
  }

  public next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return this.failure === undefined
        ? Promise.resolve({ done: true, value: undefined as never })
        : Promise.reject(this.failure);
    }
    if (signal?.aborted) {
      return Promise.reject(cancellationError());
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: undefined as (() => void) | undefined,
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          this.detach(waiter);
          reject(cancellationError());
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private detach(waiter: {
    signal: AbortSignal | undefined;
    onAbort: (() => void) | undefined;
  }): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}

export class AppServerTransport implements CodexTransport {
  private readonly supportsImages: boolean;
  private readonly failedCallTtlMs: number;
  private readonly logger: AppServerTransportLogger | undefined;
  private readonly states = new Map<string, TurnState>();
  private readonly callStates = new Map<string, TurnState>();
  private readonly failedCallTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  public constructor(
    private readonly session: AppServerTransportSession,
    private readonly registry: ToolContinuationRegistry = new ToolContinuationRegistry(),
    options: AppServerTransportOptions = {},
  ) {
    this.supportsImages = options.supportsImages ?? true;
    this.failedCallTtlMs = options.failedCallTtlMs ?? DEFAULT_FAILED_CALL_TTL_MS;
    this.logger = options.logger;
    if (!Number.isFinite(this.failedCallTtlMs) || this.failedCallTtlMs <= 0) {
      throw new RangeError("failedCallTtlMs must be positive");
    }
  }

  public async listModels(
    options: { silent: boolean; forceRefresh?: boolean },
    signal: AbortSignal,
  ): Promise<readonly CodexModel[]> {
    this.throwIfDisposed();
    if (signal.aborted) {
      throw cancellationError();
    }
    let models: readonly CodexModel[];
    try {
      models = await this.session.listModels(options.forceRefresh === true);
    } catch (error) {
      if (
        options.silent
        && error instanceof CodexError
        && (error.code === "process"
          || error.code === "authRequired"
          || error.code === "incompatible")
      ) {
        return [];
      }
      throw error;
    }
    if (signal.aborted) {
      throw cancellationError();
    }
    return models;
  }

  public generate(request: CodexRequest, signal: AbortSignal): AsyncIterable<TransportEvent> {
    if (this.disposed) {
      throw cancellationError();
    }
    return this.generateEvents(request, signal);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const active = [...this.states.values()];
    await Promise.allSettled(active.map((state) => this.terminateState(
      state,
      cancellationError(),
      true,
    )));
    this.registry.dispose();
    for (const timer of this.failedCallTimers.values()) {
      clearTimeout(timer);
    }
    this.failedCallTimers.clear();
    await this.session.dispose();
  }

  private async *generateEvents(
    request: CodexRequest,
    signal: AbortSignal,
  ): AsyncIterable<TransportEvent> {
    this.throwIfDisposed();
    if (signal.aborted) {
      throw cancellationError();
    }

    let activeState: TurnState | undefined;
    try {
      const results = this.extractToolResults(request.messages);
      if (results.some((result) => this.failedCallTimers.has(result.callId))) {
        throw new CodexError("toolContinuation", { action: "restartCodex" });
      }
      const continuationState = this.findContinuationState(results);

      if (continuationState !== undefined) {
        activeState = continuationState;
        this.bindSignal(continuationState, signal);
        continuationState.keepAlive = false;
        const newResults = results.filter((result) =>
          this.callStates.get(callKey(
            result.callId,
            continuationState.generation,
            continuationState.leaseId,
          )) === continuationState
          && this.registry.has(result.callId, stateIdentity(continuationState))
          && !continuationState.receivedCallIds.has(result.callId)
          && this.registry.received(result.callId, stateIdentity(continuationState)) === undefined);
        this.assertContinuationImages(continuationState, newResults);
        if (newResults.length > 0) {
          for (const result of newResults) {
            this.logger?.event("appServer.tool.resultReceived", {
              toolName: continuationState.callNames.get(result.callId),
            });
          }
          const resumed = this.registry.resume(newResults, signal, {
            generation: continuationState.generation,
            leaseId: continuationState.leaseId,
          });
          for (const result of newResults) {
            continuationState.receivedCallIds.add(result.callId);
          }
          if (resumed !== undefined) {
            for (const result of newResults) {
              this.logger?.event("appServer.tool.resumed", {
                toolName: continuationState.callNames.get(result.callId),
              });
            }
            yield* resumed;
            return;
          }
        }

        if (this.registry.unsurfaced(
          continuationState.threadId,
          continuationState.turnId,
          stateIdentity(continuationState),
        ).length > 0) {
          yield* this.consumeState(continuationState, signal);
        } else if (this.registry.hasState(
          continuationState.threadId,
          continuationState.turnId,
          stateIdentity(continuationState),
        )) {
          continuationState.keepAlive = true;
        }
        return;
      }

      const state = await this.startTurn(request, signal);
      activeState = state;
      yield* this.consumeState(state, signal);
    } catch (cause) {
      const error = asError(cause, protocolError("turn"));
      if (activeState !== undefined && !activeState.cleaned) {
        await this.terminateState(activeState, error, true);
      }
      throw cause;
    } finally {
      if (activeState !== undefined && !activeState.cleaned && !activeState.keepAlive) {
        const cleanupError = await this.terminateState(activeState, cancellationError(), true);
        if (cleanupError !== undefined) {
          throw cleanupError;
        }
      }
    }
  }

  private async startTurn(request: CodexRequest, signal: AbortSignal): Promise<TurnState> {
    const lease = await this.session.acquireTransportLease();
    let state: TurnState | undefined;
    try {
      if (signal.aborted) {
        throw cancellationError();
      }
      if (!lease.capabilities.dynamicTools) {
        throw new CodexError("incompatible", { action: "upgradeCodex" });
      }
      const models = await this.session.listModels();
      const selectedModel = models.find((candidate) => candidate.id === request.modelId);
      if (selectedModel === undefined) {
        throw protocolError("model/list", new Error(`unknown model: ${request.modelId}`));
      }
      const supportsImages = this.supportsImages && selectedModel.capabilities.imageInput;
      const dynamicTools = request.tools.map((tool): AppServerDynamicTool => {
        if (!TOOL_NAME_PATTERN.test(tool.name)) {
          throw new CodexError("protocol", {
            action: "invalidToolName",
            cause: new Error(tool.name),
          });
        }
        return {
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          deferLoading: false,
        };
      });
      const toolCapabilities = classifySapTools(request.tools.map((tool) => tool.name));
      const virtualActivatorCapabilities = request.tools
        .filter((tool) => tool.name.startsWith("activate_"))
        .map((tool) => [
          tool.name.slice("activate_".length),
          tool.description,
          JSON.stringify(tool.inputSchema),
        ].join(" ").toLowerCase());
      this.logger?.event("appServer.request.tools", {
        toolMode: request.toolMode,
        toolCount: request.tools.length,
        hasAbapRead: toolCapabilities.read.length > 0,
        hasWorkspaceUriResolver: toolCapabilities.resolveWorkspaceUri.length > 0,
        hasCreate: toolCapabilities.create.length > 0,
        hasGenericEdit: toolCapabilities.edit.some((name) =>
          name === "replace_string_in_file" || name === "insert_edit_into_file"),
        hasAbapSemanticEdit: toolCapabilities.edit.includes("replace_string_in_abap_object"),
        hasDiagnostics: toolCapabilities.diagnostics.length > 0,
        hasActivate: toolCapabilities.activate.length > 0,
        virtualActivatorCount: virtualActivatorCapabilities.length,
        hasVirtualEditActivator: virtualActivatorCapabilities.some((capability) =>
          /\b(edit|editing|replace|write|writing)\b/u.test(capability)),
        hasVirtualActivateActivator: virtualActivatorCapabilities.some((capability) =>
          /\b(activate|activation)\b/u.test(capability)),
      });
      const thread = await lease.startThread(dynamicTools, signal);
      state = {
        generation: lease.generation,
        leaseId: lease.leaseId,
        lease,
        threadId: thread.threadId,
        turnId: "",
        supportsImages,
        requireToolCall: request.toolMode === "required",
        toolNames: new Set(dynamicTools.map((tool) => tool.name)),
        queue: new AsyncQueue<QueueItem>(),
        registrations: [],
        callIds: new Set(),
        callNames: new Map(),
        lastThreadUsage: undefined,
        threadUsageSeen: false,
        surfacedCallIds: new Set(),
        receivedCallIds: new Set(),
        preResponseNotifications: [],
        preResponseToolCalls: [],
        signal: undefined,
        onAbort: undefined,
        terminal: false,
        failure: undefined,
        cleanupStarted: false,
        cleaned: false,
        consumerActive: false,
        keepAlive: false,
        streamedAgentText: new Map(),
        cleanupPromise: undefined,
      };
      this.attachHandlers(state);
      const turn = await lease.startTurn({
        threadId: state.threadId,
        modelId: request.modelId,
        input: serializeTranscript(request.messages, {
          supportsImages,
          instructions: buildAppServerTurnInstructions(request.instructions, request.toolMode),
        }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
      }, signal);
      if (
        state.cleaned
        || state.cleanupStarted
        || this.disposed
        || signal.aborted
      ) {
        const error = state.failure ?? cancellationError();
        if (!state.cleaned && !state.cleanupStarted) {
          state.turnId = turn.turnId;
          await this.terminateState(state, error, true);
        }
        throw error;
      }
      state.turnId = turn.turnId;
      this.states.set(chainKey(
        state.threadId,
        state.turnId,
        state.generation,
        state.leaseId,
      ), state);
      this.flushPreResponse(state);
      this.bindSignal(state, signal);
      return state;
    } catch (cause) {
      if (state !== undefined) {
        await this.terminateState(state, asError(cause, protocolError("turn/start")), true);
      } else {
        lease.release();
      }
      throw cause;
    }
  }

  private attachHandlers(state: TurnState): void {
    const registerNotification = (method: AppServerNotificationMethod): void => {
      state.registrations.push(state.lease.onNotification(method, (params) => {
        this.handleNotification(state, method, params);
      }));
    };
    for (const method of [
      "turn/started",
      "item/agentMessage/delta",
      "turn/usage",
      "thread/tokenUsage/updated",
      "turn/completed",
      "turn/failed",
      "turn/error",
    ] as const) {
      registerNotification(method);
    }
    state.registrations.push(state.lease.onToolCall((params, rpcId) =>
      this.handleToolRequest(state, params, rpcId)));
    state.registrations.push(state.lease.onSecurityFailure((failure) => {
      this.handleSecurityFailure(state, failure);
    }));
    state.registrations.push(state.lease.onProcessExit((error) => {
      this.handleProcessExit(state, error);
    }));
  }

  private handleNotification(
    state: TurnState,
    method: AppServerNotificationMethod,
    params: unknown,
    allowPreResponse = true,
  ): void {
    const correlation = readCorrelation(params);
    if (correlation === undefined || correlation.threadId !== state.threadId) {
      return;
    }
    if (state.turnId === "") {
      if (allowPreResponse) {
        state.preResponseNotifications.push({ method, params });
      }
      return;
    }
    if (correlation.turnId !== state.turnId || state.cleaned || state.cleanupStarted) {
      return;
    }
    if (method === "item/agentMessage/delta") {
      if (!isRecord(params)) {
        return;
      }
      const delta = stringValue(params.delta) ?? stringValue(params.text);
      if (delta !== undefined) {
        const itemId = stringValue(params.itemId) ?? LEGACY_AGENT_MESSAGE_ID;
        state.streamedAgentText.set(
          itemId,
          `${state.streamedAgentText.get(itemId) ?? ""}${delta}`,
        );
        state.queue.push({ kind: "event", event: { type: "text-delta", text: delta } });
      }
      return;
    }
    if (method === "turn/usage") {
      if (!isRecord(params)) {
        return;
      }
      // Prefer thread/tokenUsage/updated when the codex version emits it;
      // skip the legacy notification to avoid double counting.
      if (state.threadUsageSeen) {
        return;
      }
      const usage = isRecord(params.usage) ? params.usage : params;
      const inputTokens = numberValue(usage.inputTokens ?? usage.input_tokens);
      const cachedTokens = numberValue(usage.cachedInputTokens ?? usage.cached_input_tokens);
      const outputTokens = numberValue(usage.outputTokens ?? usage.output_tokens);
      if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined) {
        state.queue.push({ kind: "event", event: {
          type: "usage",
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedTokens === undefined ? {} : { cachedTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        } });
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      // codex app-server (>= 0.144) reports cumulative thread token usage here,
      // including cachedInputTokens. Emit deltas so consumers can simply sum.
      if (!isRecord(params)) {
        this.logger?.event("appServer.usage.invalidNotification");
        return;
      }
      state.threadUsageSeen = true;
      const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
      const total = isRecord(tokenUsage?.total) ? tokenUsage?.total : undefined;
      if (total === undefined) {
        this.logger?.event("appServer.usage.missingTotal");
        return;
      }
      const inputTokens = numberValue(total.inputTokens ?? total.input_tokens) ?? 0;
      const cachedTokens = numberValue(total.cachedInputTokens ?? total.cached_input_tokens) ?? 0;
      const outputTokens = numberValue(total.outputTokens ?? total.output_tokens) ?? 0;
      const previous = state.lastThreadUsage ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
      state.lastThreadUsage = { inputTokens, cachedTokens, outputTokens };
      const deltaInput = Math.max(0, inputTokens - previous.inputTokens);
      const deltaCached = Math.max(0, cachedTokens - previous.cachedTokens);
      const deltaOutput = Math.max(0, outputTokens - previous.outputTokens);
      this.logger?.event("appServer.usage.updated", {
        inputTokens,
        cachedTokens,
        outputTokens,
        deltaInput,
        deltaCached,
        deltaOutput,
      });
      if (deltaInput > 0 || deltaCached > 0 || deltaOutput > 0) {
        this.logger?.event("appServer.usage.emitted", {
          inputTokens: deltaInput,
          cachedTokens: deltaCached,
          outputTokens: deltaOutput,
        });
        state.queue.push({ kind: "event", event: {
          type: "usage",
          ...(deltaInput === 0 ? {} : { inputTokens: deltaInput }),
          ...(deltaCached === 0 ? {} : { cachedTokens: deltaCached }),
          ...(deltaOutput === 0 ? {} : { outputTokens: deltaOutput }),
        } });
      }
      return;
    }
    if (method === "turn/completed") {
      const record = isRecord(params) ? params : undefined;
      const turn = isRecord(record?.turn) ? record.turn : undefined;
      const status = stringValue(turn?.status) ?? stringValue(record?.status);
      const legacyCompleted = record !== undefined
        && turn === undefined
        && status === undefined
        && !hasOwn(record, "turn")
        && !hasOwn(record, "status");
      if (status !== "completed" && !legacyCompleted) {
        const error = status === "interrupted"
          ? cancellationError()
          : protocolError("turn/completed", new Error("App Server turn did not complete successfully"));
        state.terminal = true;
        state.failure = error;
        state.queue.fail(error);
        void this.terminateState(state, error, false);
        return;
      }
      if (state.requireToolCall && state.callIds.size === 0) {
        this.logger?.event("appServer.requiredTool.missing", { toolMode: "required" });
        const error = new CodexError("requiredToolMissing", { action: "showDiagnostics" });
        state.terminal = true;
        state.failure = error;
        state.queue.fail(error);
        void this.terminateState(state, error, false);
        return;
      }
      const finalMessage = readFinalAgentMessage(turn);
      if (finalMessage !== undefined) {
        const itemId = finalMessage.id ?? LEGACY_AGENT_MESSAGE_ID;
        const streamed = state.streamedAgentText.get(itemId) ?? "";
        if (!finalMessage.text.startsWith(streamed)) {
          const error = protocolError(
            "turn/completed",
            new Error("App Server final agent message did not match its streamed deltas"),
          );
          state.terminal = true;
          state.failure = error;
          state.queue.fail(error);
          void this.terminateState(state, error, false);
          return;
        }
        const suffix = finalMessage.text.slice(streamed.length);
        if (suffix.length > 0) {
          state.streamedAgentText.set(itemId, finalMessage.text);
          state.queue.push({ kind: "event", event: { type: "text-delta", text: suffix } });
        }
      }
      state.terminal = true;
      state.queue.push({ kind: "event", event: { type: "completed" } });
      return;
    }
    if (method === "turn/failed" || method === "turn/error") {
      const error = protocolError("turn", new Error("App Server turn failed"));
      state.terminal = true;
      state.failure = error;
      state.queue.fail(error);
      void this.terminateState(state, error, true);
    }
  }

  private handleToolRequest(
    state: TurnState,
    params: unknown,
    rpcId: JsonRpcId,
  ): Promise<unknown> {
    const correlation = readCorrelation(params);
    if (
      state.cleaned
      || state.cleanupStarted
      || state.terminal
      || state.failure !== undefined
    ) {
      return Promise.reject(protocolError("lateToolCall"));
    }
    if (correlation === undefined || correlation.threadId !== state.threadId) {
      return Promise.reject(protocolError("item/tool/call"));
    }
    if (state.turnId === "") {
      return new Promise<unknown>((resolve, reject) => {
        state.preResponseToolCalls.push({ params, rpcId, resolve, reject });
      });
    }
    if (correlation.turnId !== state.turnId) {
      return Promise.reject(protocolError("item/tool/call"));
    }
    return this.handleToolCall(state, params, rpcId);
  }

  private flushPreResponse(state: TurnState): void {
    const notifications = state.preResponseNotifications.splice(0);
    for (const notification of notifications) {
      const correlation = readCorrelation(notification.params);
      if (correlation?.threadId === state.threadId && correlation.turnId === state.turnId) {
        this.handleNotification(state, notification.method, notification.params, false);
      }
    }
    const toolCalls = state.preResponseToolCalls.splice(0);
    for (const toolCall of toolCalls) {
      const correlation = readCorrelation(toolCall.params);
      if (correlation?.threadId !== state.threadId || correlation.turnId !== state.turnId) {
        toolCall.reject(protocolError("item/tool/call"));
        continue;
      }
      void this.handleToolCall(state, toolCall.params, toolCall.rpcId)
        .then(toolCall.resolve, toolCall.reject);
    }
  }

  private handleToolCall(
    state: TurnState,
    params: unknown,
    rpcId: JsonRpcId,
  ): Promise<unknown> {
    if (
      state.cleaned
      || state.cleanupStarted
      || state.terminal
      || state.failure !== undefined
    ) {
      return Promise.reject(protocolError("lateToolCall"));
    }
    let call: ParsedToolCall;
    try {
      call = parseToolCall(params, rpcId);
    } catch (cause) {
      return Promise.reject(asError(cause, protocolError("item/tool/call")));
    }
    if (
      call.threadId !== state.threadId
      || call.turnId !== state.turnId
      || !state.toolNames.has(call.name)
    ) {
      return Promise.reject(protocolError("item/tool/call"));
    }

    return new Promise<unknown>((resolve, reject) => {
      try {
        this.clearFailedCall(call.callId);
        this.registry.capture({
          generation: state.generation,
          leaseId: state.leaseId,
          ...call,
          respond: (result) => resolve(result),
          reject: (error) => {
            reject(error);
            queueMicrotask(() => {
              if (!state.cleaned && !state.cleanupStarted) {
                void this.terminateState(state, error, !state.terminal);
              }
            });
          },
          continue: (signal) => this.consumeState(state, signal),
        });
        state.callIds.add(call.callId);
        state.callNames.set(call.callId, call.name);
        this.logger?.event("appServer.tool.requested", { toolName: call.name });
        this.callStates.set(callKey(call.callId, state.generation, state.leaseId), state);
        state.queue.push({ kind: "tool" });
      } catch (cause) {
        reject(cause);
      }
    });
  }

  private handleSecurityFailure(state: TurnState, failure: AppServerSecurityFailure): void {
    if (
      state.cleaned
      || state.cleanupStarted
      || failure.generation !== state.generation
      || failure.leaseId !== state.leaseId
      || failure.threadId !== state.threadId
      || failure.turnId !== state.turnId
    ) {
      return;
    }
    const error = new CodexError("protocol", { action: "securityBoundary" });
    state.failure = error;
    state.terminal = true;
    void this.terminateState(state, error, failure.interruptIssued !== true);
  }

  private handleProcessExit(state: TurnState, error: CodexError): void {
    if (state.cleaned || state.cleanupStarted) {
      return;
    }
    const processFailure = error.code === "process"
      ? error
      : new CodexError("process", { action: "appServerExit", cause: error });
    this.registry.processExit(
      processFailure,
      state.threadId,
      state.turnId,
      stateIdentity(state),
    );
    void this.terminateState(state, processFailure, false);
  }

  private async *consumeState(
    state: TurnState,
    signal: AbortSignal,
  ): AsyncIterable<TransportEvent> {
    if (state.failure !== undefined) {
      throw state.failure;
    }
    if (state.cleaned) {
      return;
    }
    if (state.consumerActive) {
      throw protocolError("concurrentTurn");
    }
    state.consumerActive = true;
    state.keepAlive = false;
    try {
      while (!state.cleaned) {
        if (state.failure !== undefined) {
          throw state.failure;
        }
        const unsurfaced = this.registry.unsurfaced(
          state.threadId,
          state.turnId,
          stateIdentity(state),
        );
        if (unsurfaced.length > 0) {
          for (const call of unsurfaced) {
            this.registry.markSurfaced(call.callId, stateIdentity(state));
            state.surfacedCallIds.add(call.callId);
            this.logger?.event("appServer.tool.surfaced", { toolName: call.name });
            yield {
              type: "tool-call",
              callId: call.callId,
              name: call.name,
              input: call.input,
            };
          }
          if (this.registry.isReady(state.threadId, state.turnId, stateIdentity(state))) {
            this.registry.resume([], signal, {
              continueTurn: false,
              generation: state.generation,
              leaseId: state.leaseId,
              threadId: state.threadId,
              turnId: state.turnId,
            });
            continue;
          }
          state.keepAlive = true;
          return;
        }

        const item = await state.queue.next(signal);
        if (item.done) {
          return;
        }
        if (item.value.kind === "tool") {
          continue;
        }

        yield item.value.event;
        if (item.value.event.type === "completed") {
          await this.finishState(state);
          return;
        }
      }
    } catch (cause) {
      const error = asError(cause, cancellationError());
      await this.terminateState(state, error, true);
      throw cause;
    } finally {
      state.consumerActive = false;
    }
  }

  private extractToolResults(messages: CodexRequest["messages"]): ToolContinuationResult[] {
    const results: ToolContinuationResult[] = [];
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.kind !== "tool-result") {
          continue;
        }
        results.push({
          callId: part.callId,
          contentItems: part.content.map((contentPart) => {
            if (contentPart.kind === "text") {
              return { type: "inputText", text: contentPart.text };
            }
            return {
              type: "inputImage",
              imageUrl: `data:${contentPart.mimeType};base64,${Buffer.from(contentPart.data).toString("base64")}`,
            };
          }),
          success: true,
        });
      }
    }
    return results;
  }

  private assertContinuationImages(
    state: TurnState,
    results: readonly ToolContinuationResult[],
  ): void {
    if (state.supportsImages) {
      return;
    }
    if (results.some((result) => result.contentItems.some((item) =>
      isRecord(item) && item.type === "inputImage"))) {
      throw new CodexError("incompatible", { action: "imageInput" });
    }
  }

  private findContinuationState(results: readonly ToolContinuationResult[]): TurnState | undefined {
    const candidates = new Set<TurnState>();
    for (const result of results) {
      for (const state of this.states.values()) {
        if (
          state.cleaned
          || state.cleanupStarted
          || !state.callIds.has(result.callId)
          || this.callStates.get(callKey(
            result.callId,
            state.generation,
            state.leaseId,
          )) !== state
          || !this.registry.has(result.callId, stateIdentity(state))
        ) {
          continue;
        }
        candidates.add(state);
      }
    }
    if (candidates.size > 1) {
      throw protocolError("toolContinuation");
    }
    return candidates.values().next().value as TurnState | undefined;
  }

  private bindSignal(state: TurnState, signal: AbortSignal): void {
    if (state.signal === signal) {
      return;
    }
    if (state.signal !== undefined && state.onAbort !== undefined) {
      state.signal.removeEventListener("abort", state.onAbort);
    }
    state.signal = signal;
    if (signal.aborted) {
      void this.terminateState(state, cancellationError(), true);
      return;
    }
    const onAbort = (): void => {
      void this.terminateState(state, cancellationError(), true);
    };
    state.onAbort = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private async finishState(state: TurnState): Promise<void> {
    await this.terminateState(state, undefined, false);
  }

  private async terminateState(
    state: TurnState,
    error: Error | undefined,
    interrupt: boolean,
  ): Promise<Error | undefined> {
    if (state.cleanupPromise !== undefined) {
      return state.cleanupPromise;
    }
    state.cleanupStarted = true;
    state.cleaned = true;
    state.terminal = true;
    const terminationReason = this.pendingTerminationReason(error);
    const pendingCount = [...state.surfacedCallIds].filter((callId) =>
      !state.receivedCallIds.has(callId)).length;
    if (terminationReason !== undefined && pendingCount > 0) {
      this.logger?.event("appServer.tool.pendingResultTerminated", {
        reason: terminationReason,
        pendingCount,
      });
    }
    if (error !== undefined) {
      state.failure = error;
      this.registry.cancel(state.threadId, state.turnId, error, stateIdentity(state));
      state.queue.fail(error);
    } else {
      this.registry.cleanup(state.threadId, state.turnId, stateIdentity(state));
      state.queue.close();
    }
    const operation = (async (): Promise<Error | undefined> => {
      let cleanupError: Error | undefined;
      if (state.signal !== undefined && state.onAbort !== undefined) {
        state.signal.removeEventListener("abort", state.onAbort);
      }
      state.signal = undefined;
      state.onAbort = undefined;
      for (const pending of state.preResponseToolCalls.splice(0)) {
        pending.reject(error ?? cancellationError());
      }
      for (const registration of state.registrations.splice(0)) {
        try {
          registration.dispose();
        } catch {
          // Listener disposal is best effort during terminal cleanup.
        }
      }
      for (const callId of state.callIds) {
        const key = callKey(callId, state.generation, state.leaseId);
        if (this.callStates.get(key) === state) {
          this.callStates.delete(key);
        }
        if (
          error !== undefined
          && !(error instanceof CodexError && error.code === "cancelled")
          && ![...this.callStates.values()].some((candidate) =>
            !candidate.cleaned && candidate.callIds.has(callId))
        ) {
          this.rememberFailedCall(callId);
        }
      }
      const stateKey = chainKey(
        state.threadId,
        state.turnId,
        state.generation,
        state.leaseId,
      );
      if (this.states.get(stateKey) === state) {
        this.states.delete(stateKey);
      }
      if (interrupt && state.turnId !== "") {
        cleanupError = await this.boundedCall(() =>
          state.lease.interrupt(state.threadId, state.turnId));
      }
      if (state.threadId !== "") {
        const unsubscribeError = await this.boundedCall(() =>
          state.lease.unsubscribe(state.threadId));
        cleanupError ??= unsubscribeError;
      }
      try {
        state.lease.release();
      } catch (cause) {
        cleanupError ??= asError(cause, protocolError("leaseRelease"));
      }
      state.queue.close();
      return cleanupError;
    })();
    state.cleanupPromise = operation;
    await operation;
  }

  private pendingTerminationReason(error: Error | undefined): string | undefined {
    if (!(error instanceof CodexError)) {
      return undefined;
    }
    if (error.code === "cancelled" || error.code === "timeout" || error.code === "process") {
      return error.code;
    }
    return error.action === "securityBoundary" ? "security" : undefined;
  }

  private async boundedCall(operation: () => Promise<void>): Promise<Error | undefined> {
    let promise: Promise<void>;
    try {
      promise = operation();
    } catch (cause) {
      return asError(cause, protocolError("cleanup"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Error | undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), CLEANUP_TIMEOUT_MS);
      const unref = (timer as unknown as { unref?: () => void }).unref;
      unref?.call(timer);
    });
    try {
      return await Promise.race([
        promise.then(() => undefined, (cause) => asError(cause, protocolError("cleanup"))),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private rememberFailedCall(callId: string): void {
    this.clearFailedCall(callId);
    const timer = setTimeout(() => {
      this.failedCallTimers.delete(callId);
    }, this.failedCallTtlMs);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
    this.failedCallTimers.set(callId, timer);
  }

  private clearFailedCall(callId: string): void {
    const timer = this.failedCallTimers.get(callId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.failedCallTimers.delete(callId);
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw cancellationError();
    }
  }
}

interface ParsedToolCall {
  rpcId: JsonRpcId;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  input: unknown;
}

function parseToolCall(params: unknown, rpcId: JsonRpcId): ParsedToolCall {
  if (!isRecord(params)) {
    throw protocolError("item/tool/call");
  }
  const callId = stringValue(params.callId);
  const name = stringValue(params.name) ?? stringValue(params.tool);
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  if (threadId === undefined || turnId === undefined || callId === undefined || name === undefined) {
    throw protocolError("item/tool/call");
  }
  return {
    rpcId,
    threadId,
    turnId,
    callId,
    name,
    input: params.input ?? params.arguments,
  };
}
