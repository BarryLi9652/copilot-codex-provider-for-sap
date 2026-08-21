import { CodexError } from "../../core/errors.js";
import type { TransportEvent } from "../../core/types.js";
import type { JsonRpcId } from "./protocol.js";

export interface ToolContinuationResult {
  callId: string;
  contentItems: readonly unknown[];
  success: boolean;
}

export interface PendingToolCall {
  rpcId: JsonRpcId;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  input?: unknown;
  expiresAt: number;
  surfacedToCopilot: boolean;
  receivedResult?: ToolContinuationResult;
  respond(result: { contentItems: readonly unknown[]; success: boolean }): void;
  reject(error: Error): void;
}

export interface PendingToolCallRequest {
  rpcId: JsonRpcId;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  input?: unknown;
  expiresAt?: number;
  respond(result: { contentItems: readonly unknown[]; success: boolean }): void;
  reject(error: Error): void;
  continue?: (signal: AbortSignal) => AsyncIterable<TransportEvent>;
}

export interface PendingContinuation {
  readonly threadId: string;
  readonly turnId: string;
  readonly calls: readonly PendingToolCall[];
}

export interface ToolContinuationResumeOptions {
  continueTurn?: boolean;
  threadId?: string;
  turnId?: string;
}

export interface ToolContinuationRegistryOptions {
  now?: () => number;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ContinuationState extends PendingContinuation {
  readonly callMap: Map<string, PendingToolCall>;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  continueTurn: ((signal: AbortSignal) => AsyncIterable<TransportEvent>) | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

const continuationError = (): CodexError => new CodexError("toolContinuation", {
  action: "resumeToolCall",
});

const chainKey = (threadId: string, turnId: string): string => `${threadId}\u0000${turnId}`;

export class ToolContinuationRegistry {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly setTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly callsById = new Map<string, { call: PendingToolCall; state: ContinuationState }>();
  private readonly states = new Map<string, ContinuationState>();

  public constructor(options: ToolContinuationRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.setTimeout = options.setTimeout ?? ((callback, milliseconds) =>
      setTimeout(callback, milliseconds));
    this.clearTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be positive");
    }
  }

  public get size(): number {
    return this.callsById.size;
  }

  public has(callId: string): boolean {
    return this.callsById.has(callId);
  }

  public hasState(threadId: string, turnId: string): boolean {
    return this.states.has(chainKey(threadId, turnId));
  }

  public isReady(threadId: string, turnId: string): boolean {
    const state = this.states.get(chainKey(threadId, turnId));
    if (state === undefined) {
      return false;
    }
    return [...state.callMap.values()].every((call) =>
      call.surfacedToCopilot && call.receivedResult !== undefined);
  }

  public capture(request: PendingToolCallRequest): PendingContinuation {
    if (request.callId.length === 0 || request.threadId.length === 0 || request.turnId.length === 0) {
      throw continuationError();
    }
    if (this.callsById.has(request.callId)) {
      throw continuationError();
    }

    const key = chainKey(request.threadId, request.turnId);
    let state = this.states.get(key);
    if (state === undefined) {
      const callMap = new Map<string, PendingToolCall>();
      state = {
        threadId: request.threadId,
        turnId: request.turnId,
        calls: [],
        callMap,
        timers: new Map(),
        continueTurn: request.continue,
        signal: undefined,
        onAbort: undefined,
      };
      Object.defineProperty(state, "calls", {
        enumerable: true,
        configurable: false,
        get: () => Object.freeze([...callMap.values()]),
      });
      this.states.set(key, state);
    } else if (request.continue !== undefined) {
      state.continueTurn = request.continue;
    }

    const expiresAt = request.expiresAt ?? this.now() + this.timeoutMs;
    if (!Number.isFinite(expiresAt)) {
      throw continuationError();
    }
    const call: PendingToolCall = {
      rpcId: request.rpcId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      name: request.name,
      ...(request.input === undefined ? {} : { input: request.input }),
      expiresAt,
      surfacedToCopilot: false,
      respond: request.respond,
      reject: request.reject,
    };
    state.callMap.set(call.callId, call);
    this.callsById.set(call.callId, { call, state });
    const timer = this.setTimeout(() => {
      const entry = this.callsById.get(call.callId);
      if (entry?.state === state) {
        this.terminate(state, new CodexError("timeout"));
      }
    }, Math.max(0, expiresAt - this.now()));
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
    state.timers.set(call.callId, timer);
    return state;
  }

  public markSurfaced(callId: string): void {
    const entry = this.callsById.get(callId);
    if (entry === undefined) {
      throw continuationError();
    }
    entry.call.surfacedToCopilot = true;
  }

  public unsurfaced(threadId: string, turnId: string): readonly PendingToolCall[] {
    const state = this.states.get(chainKey(threadId, turnId));
    if (state === undefined) {
      return [];
    }
    return [...state.callMap.values()].filter((call) => !call.surfacedToCopilot);
  }

  public received(callId: string): ToolContinuationResult | undefined {
    return this.callsById.get(callId)?.call.receivedResult;
  }

  public resume(
    results: readonly ToolContinuationResult[],
    signal: AbortSignal,
    options: ToolContinuationResumeOptions = {},
  ): AsyncIterable<TransportEvent> | undefined {
    const state = this.findState(results, options);
    if (state === undefined) {
      if (signal.aborted && this.states.size === 1) {
        const onlyState = this.states.values().next().value as ContinuationState | undefined;
        if (onlyState !== undefined) {
          this.terminate(onlyState, new CodexError("cancelled"));
        }
      }
      return undefined;
    }
    this.bindSignal(state, signal);
    if (signal.aborted) {
      this.terminate(state, new CodexError("cancelled"));
      return undefined;
    }

    const seen = new Set<string>();
    const entries: Array<{ call: PendingToolCall; result: ToolContinuationResult }> = [];
    for (const result of results) {
      if (seen.has(result.callId)) {
        throw continuationError();
      }
      seen.add(result.callId);
      const entry = this.callsById.get(result.callId);
      if (entry === undefined || entry.state !== state || entry.call.receivedResult !== undefined) {
        throw continuationError();
      }
      entries.push({ call: entry.call, result });
    }

    for (const { call, result } of entries) {
      call.receivedResult = result;
    }

    const pending = [...state.callMap.values()];
    if (pending.some((call) => !call.surfacedToCopilot || call.receivedResult === undefined)) {
      return undefined;
    }

    try {
      for (const call of pending) {
        const receivedResult = call.receivedResult;
        if (receivedResult === undefined) {
          throw continuationError();
        }
        call.respond({
          contentItems: receivedResult.contentItems,
          success: receivedResult.success,
        });
      }
    } catch (cause) {
      this.terminate(state, cause instanceof Error ? cause : continuationError());
      throw cause;
    }

    const continueTurn = state.continueTurn;
    this.removeState(state);
    return options.continueTurn === false ? undefined : continueTurn?.(signal);
  }

  public expire(now = this.now()): number {
    let expiredCalls = 0;
    for (const state of [...this.states.values()]) {
      const expired = [...state.callMap.values()].filter((call) => call.expiresAt <= now);
      if (expired.length === 0) {
        continue;
      }
      expiredCalls += expired.length;
      this.terminate(state, new CodexError("timeout"));
    }
    return expiredCalls;
  }

  public cancel(
    threadId: string,
    turnId: string,
    error: Error = new CodexError("cancelled"),
  ): void {
    const state = this.states.get(chainKey(threadId, turnId));
    if (state !== undefined) {
      this.terminate(state, error);
    }
  }

  public cleanup(threadId: string, turnId: string): void {
    const state = this.states.get(chainKey(threadId, turnId));
    if (state !== undefined) {
      this.removeState(state);
    }
  }

  public processExit(
    error: Error = new CodexError("process"),
    threadId?: string,
    turnId?: string,
  ): void {
    if (threadId !== undefined && turnId !== undefined) {
      const state = this.states.get(chainKey(threadId, turnId));
      if (state !== undefined) {
        this.terminate(state, error);
      }
      return;
    }
    for (const state of [...this.states.values()]) {
      this.terminate(state, error);
    }
  }

  public dispose(): void {
    this.processExit(new CodexError("cancelled"));
  }

  private findState(
    results: readonly ToolContinuationResult[],
    options: ToolContinuationResumeOptions,
  ): ContinuationState | undefined {
    if (results.length === 0) {
      if (options.threadId !== undefined && options.turnId !== undefined) {
        return this.states.get(chainKey(options.threadId, options.turnId));
      }
      if (this.states.size !== 1) {
        return undefined;
      }
      return this.states.values().next().value as ContinuationState | undefined;
    }
    const first = this.callsById.get(results[0]?.callId ?? "");
    if (first === undefined) {
      throw continuationError();
    }
    return first.state;
  }

  private bindSignal(state: ContinuationState, signal: AbortSignal): void {
    if (state.signal === signal) {
      return;
    }
    if (state.signal !== undefined && state.onAbort !== undefined) {
      state.signal.removeEventListener("abort", state.onAbort);
    }
    state.signal = signal;
    if (signal.aborted) {
      return;
    }
    const onAbort = (): void => {
      if (this.states.get(chainKey(state.threadId, state.turnId)) === state) {
        this.terminate(state, new CodexError("cancelled"));
      }
    };
    state.onAbort = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private terminate(state: ContinuationState, error: Error): void {
    for (const call of state.callMap.values()) {
      try {
        call.reject(error);
      } catch {
        // A failed rejection observer must not prevent the remaining IDs from being cleared.
      }
    }
    this.removeState(state);
  }

  private removeState(state: ContinuationState): void {
    const key = chainKey(state.threadId, state.turnId);
    if (this.states.get(key) !== state) {
      return;
    }
    this.states.delete(key);
    for (const callId of state.callMap.keys()) {
      this.callsById.delete(callId);
    }
    if (state.signal !== undefined && state.onAbort !== undefined) {
      state.signal.removeEventListener("abort", state.onAbort);
    }
    state.signal = undefined;
    state.onAbort = undefined;
    for (const timer of state.timers.values()) {
      this.clearTimeout(timer);
    }
    state.timers.clear();
    state.callMap.clear();
  }
}
