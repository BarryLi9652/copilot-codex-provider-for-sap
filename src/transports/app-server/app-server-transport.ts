import { CodexError } from "../../core/errors.js";
import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  MessagePart,
  TransportEvent,
} from "../../core/types.js";
import {
  type AppServerSessionClient,
  type AppServerCapabilities,
} from "./app-server-session.js";
import { APP_SERVER_THREAD_CONFIG } from "./safety-profile.js";
import {
  type Disposable,
  type JsonRpcId,
  type JsonRpcServerNotificationHandler,
  type JsonRpcServerRequestHandler,
  protocolError,
} from "./protocol.js";
import { serializeTranscript } from "./transcript.js";
import {
  ToolContinuationRegistry,
  type PendingToolCall,
  type ToolContinuationResult,
} from "./tool-continuations.js";

export type { AppServerSessionClient } from "./app-server-session.js";

export interface AppServerTransportSession {
  initialize(): Promise<AppServerCapabilities>;
  listModels(): Promise<readonly CodexModel[]>;
  getClient(): AppServerSessionClient;
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  dispose?(): Promise<void>;
}

export interface AppServerTransportOptions {
  supportsImages?: boolean;
}

interface DynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  deferLoading: false;
}

type QueueItem =
  | { kind: "event"; event: TransportEvent }
  | { kind: "tool" };

interface TurnState {
  readonly threadId: string;
  turnId: string;
  readonly client: AppServerSessionClient;
  readonly toolNames: ReadonlySet<string>;
  readonly queue: AsyncQueue<QueueItem>;
  readonly registrations: Disposable[];
  readonly callIds: Set<string>;
  readonly seenCallIds: Set<string>;
  readonly receivedCallIds: Set<string>;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  terminal: boolean;
  failure: Error | undefined;
  cleaned: boolean;
  consumerActive: boolean;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const chainKey = (threadId: string, turnId: string): string => `${threadId}\u0000${turnId}`;

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
  private readonly states = new Map<string, TurnState>();
  private readonly callStates = new Map<string, TurnState>();
  private disposed = false;

  public constructor(
    private readonly session: AppServerTransportSession,
    private readonly registry: ToolContinuationRegistry = new ToolContinuationRegistry(),
    options: AppServerTransportOptions = {},
  ) {
    this.supportsImages = options.supportsImages ?? true;
  }

  public async listModels(
    _options: { silent: boolean; forceRefresh?: boolean },
    signal: AbortSignal,
  ): Promise<readonly CodexModel[]> {
    this.throwIfDisposed();
    if (signal.aborted) {
      throw cancellationError();
    }
    await this.session.initialize();
    if (signal.aborted) {
      throw cancellationError();
    }
    return this.session.listModels();
  }

  public generate(request: CodexRequest, signal: AbortSignal): AsyncIterable<TransportEvent> {
    if (this.disposed) {
      throw new CodexError("cancelled");
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
    await this.session.dispose?.();
  }

  private async *generateEvents(
    request: CodexRequest,
    signal: AbortSignal,
  ): AsyncIterable<TransportEvent> {
    this.throwIfDisposed();
    if (signal.aborted) {
      throw cancellationError();
    }

    const results = this.extractToolResults(request.messages);
    const continuationState = this.findContinuationState(results);
    if (results.length > 0 && continuationState === undefined) {
      this.registry.resume(results, signal);
      return;
    }

    if (continuationState !== undefined) {
      this.bindSignal(continuationState, signal);
      const newResults = results.filter((result) => !continuationState.receivedCallIds.has(result.callId));
      if (newResults.length > 0) {
        const resumed = this.registry.resume(newResults, signal);
        for (const result of newResults) {
          continuationState.receivedCallIds.add(result.callId);
        }
        if (resumed !== undefined) {
          yield* resumed;
          return;
        }
      }
      if (this.registry.unsurfaced(continuationState.threadId, continuationState.turnId).length > 0) {
        yield* this.consumeState(continuationState, signal);
      }
      return;
    }

    const state = await this.startTurn(request, signal);
    try {
      yield* this.consumeState(state, signal);
    } catch (cause) {
      await this.terminateState(state, asError(cause, protocolError("turn/start")), true);
      throw cause;
    }
  }

  private async startTurn(request: CodexRequest, signal: AbortSignal): Promise<TurnState> {
    await this.session.initialize();
    if (signal.aborted) {
      throw cancellationError();
    }
    const dynamicTools = request.tools.map((tool): DynamicTool => {
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
    const threadResponse = await this.session.request<unknown>("thread/start", {
      ...APP_SERVER_THREAD_CONFIG,
      dynamicTools,
    }, signal);
    const threadId = parseThreadId(threadResponse);
    const client = this.session.getClient();
    const state: TurnState = {
      threadId,
      turnId: "",
      client,
      toolNames: new Set(dynamicTools.map((tool) => tool.name)),
      queue: new AsyncQueue<QueueItem>(),
      registrations: [],
      callIds: new Set(),
      seenCallIds: new Set(),
      receivedCallIds: new Set(),
      signal: undefined,
      onAbort: undefined,
      terminal: false,
      failure: undefined,
      cleaned: false,
      consumerActive: false,
    };
    this.attachHandlers(state);
    try {
      const turnResponse = await this.session.request<unknown>("turn/start", {
        threadId,
        model: request.modelId,
        input: serializeTranscript(request.messages, { supportsImages: this.supportsImages }),
      }, signal);
      state.turnId = parseTurnId(turnResponse);
      this.states.set(chainKey(state.threadId, state.turnId), state);
      this.bindSignal(state, signal);
      return state;
    } catch (cause) {
      await this.terminateState(state, asError(cause, protocolError("turn/start")), true);
      throw cause;
    }
  }

  private attachHandlers(state: TurnState): void {
    const registerNotification = (
      method: string,
      handler: JsonRpcServerNotificationHandler,
    ): void => {
      state.registrations.push(state.client.onServerNotification(method, handler));
    };

    const matches = (params: unknown): boolean => {
      if (!isRecord(params)) {
        return false;
      }
      const threadId = stringValue(params.threadId);
      const turnId = stringValue(params.turnId);
      return (threadId === undefined || threadId === state.threadId)
        && (state.turnId === "" || turnId === undefined || turnId === state.turnId);
    };

    const deltaHandler: JsonRpcServerNotificationHandler = (params) => {
      if (!matches(params) || !isRecord(params)) {
        return;
      }
      const delta = stringValue(params.delta) ?? stringValue(params.text);
      if (delta !== undefined) {
        state.queue.push({ kind: "event", event: { type: "text-delta", text: delta } });
      }
    };
    registerNotification("item/agentMessage/delta", deltaHandler);

    const usageHandler: JsonRpcServerNotificationHandler = (params) => {
      if (!matches(params) || !isRecord(params) || !isRecord(params.usage)) {
        return;
      }
      const usage = params.usage;
      const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
      const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        state.queue.push({ kind: "event", event: {
          type: "usage",
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        } });
      }
    };
    registerNotification("turn/usage", usageHandler);

    const completeHandler: JsonRpcServerNotificationHandler = (params) => {
      if (!matches(params)) {
        return;
      }
      state.terminal = true;
      state.queue.push({ kind: "event", event: { type: "completed" } });
    };
    registerNotification("turn/completed", completeHandler);

    const failureHandler: JsonRpcServerNotificationHandler = (params) => {
      if (!matches(params)) {
        return;
      }
      const error = protocolError("turn", new Error("App Server turn failed"));
      state.terminal = true;
      state.failure = error;
      state.queue.fail(error);
      void this.terminateState(state, error, false);
    };
    registerNotification("turn/failed", failureHandler);
    registerNotification("turn/error", failureHandler);

    const startedHandler: JsonRpcServerNotificationHandler = (params) => {
      if (!isRecord(params) || stringValue(params.threadId) !== state.threadId) {
        return;
      }
      const turnId = stringValue(params.turnId);
      if (state.turnId === "" && turnId !== undefined) {
        state.turnId = turnId;
      }
    };
    registerNotification("turn/started", startedHandler);

    const toolHandler: JsonRpcServerRequestHandler = (params, rpcId) =>
      this.handleToolCall(state, params, rpcId);
    state.registrations.push(state.client.onServerRequest("item/tool/call", toolHandler));
  }

  private handleToolCall(
    state: TurnState,
    params: unknown,
    rpcId: JsonRpcId,
  ): Promise<unknown> {
    let call: ParsedToolCall;
    try {
      call = parseToolCall(params, rpcId);
    } catch (cause) {
      const error = asError(cause, protocolError("item/tool/call"));
      void this.terminateState(state, error, true);
      return Promise.reject(error);
    }
    if (
      call.threadId !== state.threadId
      || state.turnId !== "" && call.turnId !== state.turnId
      || !state.toolNames.has(call.name)
    ) {
      const error = protocolError("item/tool/call");
      void this.terminateState(state, error, true);
      return Promise.reject(error);
    }

    return new Promise<unknown>((resolve, reject) => {
      try {
        this.registry.capture({
          ...call,
          respond: (result) => resolve(result),
          reject,
          continue: (signal) => this.consumeState(state, signal),
        });
        state.callIds.add(call.callId);
        state.seenCallIds.add(call.callId);
        this.callStates.set(call.callId, state);
        state.queue.push({ kind: "tool" });
      } catch (cause) {
        reject(cause);
      }
    });
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
    try {
      while (!state.cleaned) {
        const unsurfaced = this.registry.unsurfaced(state.threadId, state.turnId);
        if (unsurfaced.length > 0) {
          for (const call of unsurfaced) {
            this.registry.markSurfaced(call.callId);
            yield {
              type: "tool-call",
              callId: call.callId,
              name: call.name,
              input: call.input,
            };
          }
          return;
        }

        const item = await state.queue.next(signal);
        if (item.done) {
          return;
        }
        if (item.value.kind === "tool") {
          const calls = this.registry.unsurfaced(state.threadId, state.turnId);
          if (calls.length === 0) {
            continue;
          }
          for (const call of calls) {
            this.registry.markSurfaced(call.callId);
            yield {
              type: "tool-call",
              callId: call.callId,
              name: call.name,
              input: call.input,
            };
          }
          return;
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

  private findContinuationState(results: readonly ToolContinuationResult[]): TurnState | undefined {
    for (const result of results) {
      const state = this.callStates.get(result.callId);
      if (state !== undefined && !state.cleaned) {
        return state;
      }
    }
    if (results.length === 0 && this.states.size === 1) {
      return this.states.values().next().value as TurnState | undefined;
    }
    return undefined;
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
  ): Promise<void> {
    if (state.cleaned) {
      return;
    }
    state.cleaned = true;
    if (state.signal !== undefined && state.onAbort !== undefined) {
      state.signal.removeEventListener("abort", state.onAbort);
    }
    state.signal = undefined;
    state.onAbort = undefined;
    if (error !== undefined) {
      this.registry.cancel(state.threadId, state.turnId, error);
      state.queue.fail(error);
    } else {
      this.registry.cleanup(state.threadId, state.turnId);
    }
    if (interrupt && state.turnId !== "") {
      await this.session.request("turn/interrupt", {
        threadId: state.threadId,
        turnId: state.turnId,
      }).catch(() => undefined);
    }
    if (state.threadId !== "") {
      await this.session.request("thread/unsubscribe", {
        threadId: state.threadId,
      }).catch(() => undefined);
    }
    for (const registration of state.registrations.splice(0)) {
      registration.dispose();
    }
    for (const callId of state.callIds) {
      this.callStates.delete(callId);
    }
    this.states.delete(chainKey(state.threadId, state.turnId));
    state.queue.close();
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new CodexError("cancelled");
    }
  }
}

function parseThreadId(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.thread) || typeof payload.thread.id !== "string") {
    throw protocolError("thread/start");
  }
  return payload.thread.id;
}

function parseTurnId(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.turn) || typeof payload.turn.id !== "string") {
    throw protocolError("turn/start");
  }
  return payload.turn.id;
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
  const item = isRecord(params.item) ? params.item : undefined;
  const threadId = stringValue(params.threadId) ?? stringValue(item?.threadId);
  const turnId = stringValue(params.turnId) ?? stringValue(item?.turnId);
  const callId = stringValue(params.callId) ?? stringValue(params.id) ?? stringValue(item?.callId);
  const name = stringValue(params.name) ?? stringValue(params.toolName) ?? stringValue(item?.name);
  if (threadId === undefined || turnId === undefined || callId === undefined || name === undefined) {
    throw protocolError("item/tool/call");
  }
  const input = params.input ?? params.arguments ?? item?.input ?? item?.arguments;
  return {
    rpcId,
    threadId,
    turnId,
    callId,
    name,
    input,
  };
}
