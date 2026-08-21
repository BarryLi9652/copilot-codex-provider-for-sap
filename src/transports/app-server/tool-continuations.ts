import { CodexError } from "../../core/errors.js";
import type { TransportEvent } from "../../core/types.js";
import type { JsonRpcId } from "./protocol.js";

export interface ToolContinuationResult {
  callId: string;
  contentItems: readonly unknown[];
  success: boolean;
}

export interface ToolContinuationIdentity {
  readonly generation: number;
  readonly leaseId: string;
}

export interface PendingToolCall {
  generation: number;
  leaseId: string;
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
  generation?: number;
  leaseId?: string;
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
  readonly generation: number;
  readonly leaseId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly calls: readonly PendingToolCall[];
}

export interface ToolContinuationResumeOptions {
  continueTurn?: boolean;
  generation?: number;
  leaseId?: string;
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

const LEGACY_IDENTITY: ToolContinuationIdentity = {
  generation: 0,
  leaseId: "legacy",
};

const identityOf = (
  generation?: number,
  leaseId?: string,
): ToolContinuationIdentity => {
  if ((generation === undefined) !== (leaseId === undefined)) {
    throw continuationError();
  }
  const identity = {
    generation: generation ?? LEGACY_IDENTITY.generation,
    leaseId: leaseId ?? LEGACY_IDENTITY.leaseId,
  };
  if (
    !Number.isSafeInteger(identity.generation)
    || identity.generation < 0
    || identity.leaseId.length === 0
  ) {
    throw continuationError();
  }
  return identity;
};

const identityFrom = (identity?: ToolContinuationIdentity): ToolContinuationIdentity =>
  identityOf(identity?.generation, identity?.leaseId);

const hasIdentity = (options: ToolContinuationResumeOptions): boolean =>
  options.generation !== undefined || options.leaseId !== undefined;

const matchesIdentity = (
  state: PendingContinuation,
  identity: ToolContinuationIdentity,
): boolean => state.generation === identity.generation && state.leaseId === identity.leaseId;

const chainKey = (
  threadId: string,
  turnId: string,
  identity: ToolContinuationIdentity,
): string => JSON.stringify([
  identity.generation,
  identity.leaseId,
  threadId,
  turnId,
]);

const callKey = (
  callId: string,
  identity: ToolContinuationIdentity,
): string => JSON.stringify([
  identity.generation,
  identity.leaseId,
  callId,
]);

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

  public has(callId: string, identity?: ToolContinuationIdentity): boolean {
    return this.callsById.has(callKey(callId, identityFrom(identity)));
  }

  public hasState(
    threadId: string,
    turnId: string,
    identity?: ToolContinuationIdentity,
  ): boolean {
    return this.states.has(chainKey(threadId, turnId, identityFrom(identity)));
  }

  public isReady(
    threadId: string,
    turnId: string,
    identity?: ToolContinuationIdentity,
  ): boolean {
    const state = this.states.get(chainKey(threadId, turnId, identityFrom(identity)));
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
    const identity = identityOf(request.generation, request.leaseId);
    const callKeyValue = callKey(request.callId, identity);
    if (this.callsById.has(callKeyValue)) {
      throw continuationError();
    }

    const key = chainKey(request.threadId, request.turnId, identity);
    let state = this.states.get(key);
    if (state === undefined) {
      const callMap = new Map<string, PendingToolCall>();
      state = {
        generation: identity.generation,
        leaseId: identity.leaseId,
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
      generation: identity.generation,
      leaseId: identity.leaseId,
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
    this.callsById.set(callKeyValue, { call, state });
    const timer = this.setTimeout(() => {
      const entry = this.callsById.get(callKeyValue);
      if (entry?.state === state) {
        this.terminate(state, new CodexError("timeout"));
      }
    }, Math.max(0, expiresAt - this.now()));
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
    state.timers.set(call.callId, timer);
    return state;
  }

  public markSurfaced(callId: string, identity?: ToolContinuationIdentity): void {
    const entry = this.callsById.get(callKey(callId, identityFrom(identity)));
    if (entry === undefined) {
      throw continuationError();
    }
    entry.call.surfacedToCopilot = true;
  }

  public unsurfaced(
    threadId: string,
    turnId: string,
    identity?: ToolContinuationIdentity,
  ): readonly PendingToolCall[] {
    const state = this.states.get(chainKey(threadId, turnId, identityFrom(identity)));
    if (state === undefined) {
      return [];
    }
    return [...state.callMap.values()].filter((call) => !call.surfacedToCopilot);
  }

  public received(
    callId: string,
    identity?: ToolContinuationIdentity,
  ): ToolContinuationResult | undefined {
    return this.callsById.get(callKey(callId, identityFrom(identity)))?.call.receivedResult;
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
      const entry = this.callsById.get(callKey(result.callId, this.identityOfState(state)));
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
    identity?: ToolContinuationIdentity,
  ): void {
    const state = this.states.get(chainKey(threadId, turnId, identityFrom(identity)));
    if (state !== undefined) {
      this.terminate(state, error);
    }
  }

  public cleanup(
    threadId: string,
    turnId: string,
    identity?: ToolContinuationIdentity,
  ): void {
    const state = this.states.get(chainKey(threadId, turnId, identityFrom(identity)));
    if (state !== undefined) {
      this.removeState(state);
    }
  }

  public processExit(
    error: Error = new CodexError("process"),
    threadId?: string,
    turnId?: string,
    identity?: ToolContinuationIdentity,
  ): void {
    if ((threadId === undefined) !== (turnId === undefined)) {
      return;
    }
    if (threadId !== undefined && turnId !== undefined) {
      const state = this.states.get(chainKey(threadId, turnId, identityFrom(identity)));
      if (state !== undefined) {
        this.terminate(state, error);
      }
      return;
    }
    if (identity !== undefined) {
      const exactIdentity = identityFrom(identity);
      for (const state of [...this.states.values()]) {
        if (matchesIdentity(state, exactIdentity)) {
          this.terminate(state, error);
        }
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
    const identity = identityOf(options.generation, options.leaseId);
    if (results.length === 0) {
      if ((options.threadId === undefined) !== (options.turnId === undefined)) {
        throw continuationError();
      }
      if (options.threadId !== undefined && options.turnId !== undefined) {
        return this.states.get(chainKey(options.threadId, options.turnId, identity));
      }
      if (hasIdentity(options)) {
        const candidates = [...this.states.values()]
          .filter((state) => matchesIdentity(state, identity));
        return candidates.length === 1 ? candidates[0] : undefined;
      }
      if (this.states.size !== 1) {
        return undefined;
      }
      return this.states.values().next().value as ContinuationState | undefined;
    }
    const callId = results[0]?.callId ?? "";
    const candidates = [...this.callsById.values()]
      .filter((entry) => entry.call.callId === callId)
      .filter((entry) => (
        !hasIdentity(options)
        || entry.call.generation === identity.generation && entry.call.leaseId === identity.leaseId
      ));
    const candidateStates = [...new Set(candidates.map((entry) => entry.state))];
    if (candidateStates.length !== 1) {
      throw continuationError();
    }
    return candidateStates[0];
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
      if (this.states.get(chainKey(
        state.threadId,
        state.turnId,
        this.identityOfState(state),
      )) === state) {
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
    const key = chainKey(state.threadId, state.turnId, this.identityOfState(state));
    if (this.states.get(key) !== state) {
      return;
    }
    this.states.delete(key);
    for (const callId of state.callMap.keys()) {
      this.callsById.delete(callKey(callId, this.identityOfState(state)));
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

  private identityOfState(state: ContinuationState): ToolContinuationIdentity {
    return { generation: state.generation, leaseId: state.leaseId };
  }
}
