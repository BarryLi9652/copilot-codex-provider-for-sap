import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";

import { CodexError } from "../../core/errors.js";
import {
  type Disposable,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcServerNotificationHandler,
  type JsonRpcServerRequestHandler,
  processError,
  protocolError,
} from "./protocol.js";

export interface JsonlRpcClientStreams {
  input: Writable;
  output: Readable;
}

export interface JsonlRpcClientOptions {
  requestTimeoutMs?: number;
  onDidTerminate?: (error: CodexError) => void;
}

interface WriteTicket {
  readonly data: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  started: boolean;
  settled: boolean;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  ticket: WriteTicket | undefined;
}

interface ActiveServerRequest {
  readonly method: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

export class JsonlRpcClient {
  private readonly input: Writable;
  private readonly output: Readable;
  private readonly requestTimeoutMs: number;
  private readonly onDidTerminate: ((error: CodexError) => void) | undefined;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly serverRequests = new Map<JsonRpcId, ActiveServerRequest>();
  private readonly serverRequestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  private readonly serverNotificationHandlers = new Map<string, JsonRpcServerNotificationHandler>();
  private readonly writeQueue: WriteTicket[] = [];
  private nextRequestId = 1;
  private lineBuffer = "";
  private activeWrite: WriteTicket | undefined;
  private closed = false;

  public constructor(
    streams: JsonlRpcClientStreams,
    options?: JsonlRpcClientOptions,
  );
  public constructor(
    output: Readable,
    input: Writable,
    options?: JsonlRpcClientOptions,
  );
  public constructor(
    first: JsonlRpcClientStreams | Readable,
    second?: JsonlRpcClientOptions | Writable,
    third?: JsonlRpcClientOptions,
  ) {
    if ("input" in first && "output" in first) {
      this.input = first.input;
      this.output = first.output;
      const options = second as JsonlRpcClientOptions | undefined;
      this.requestTimeoutMs = validateTimeout(options);
      this.onDidTerminate = options?.onDidTerminate;
    } else {
      this.output = first;
      this.input = second as Writable;
      this.requestTimeoutMs = validateTimeout(third);
      this.onDidTerminate = third?.onDidTerminate;
    }

    this.output.on("data", this.handleData);
    this.output.on("end", this.handleEnd);
    this.output.on("close", this.handleEnd);
    this.output.on("error", this.handleStreamError);
    this.input.on("error", this.handleStreamError);
    this.input.on("finish", this.handleInputEnd);
    this.input.on("close", this.handleInputEnd);
  }

  public request<T>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new CodexError("cancelled", { action: method }));
    }
    if (this.closed) {
      return Promise.reject(processError("requestAppServer"));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      const onAbort = signal === undefined ? undefined : (): void => {
        this.cancelPendingRequest(id, "cancelled");
      };
      const timer = this.requestTimeoutMs === Number.POSITIVE_INFINITY
        ? undefined
        : setTimeout(() => {
          this.cancelPendingRequest(id, "timeout");
        }, this.requestTimeoutMs);
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
        onAbort,
        timer,
        ticket: undefined,
      };
      this.pendingRequests.set(id, pending);
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const ticket = this.enqueueMessage({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
        pending.ticket = ticket;
        void ticket.promise.catch((error: unknown) => {
          if (this.pendingRequests.get(id) !== pending) {
            return;
          }
          this.pendingRequests.delete(id);
          this.cleanupPending(pending);
          reject(error);
        });
      } catch (error) {
        this.pendingRequests.delete(id);
        this.cleanupPending(pending);
        reject(error);
      }
    });
  }

  public notify(method: string, params?: unknown): void {
    const ticket = this.enqueueMessage({
      method,
      ...(params === undefined ? {} : { params }),
    });
    void ticket.promise.catch(() => undefined);
  }

  public onServerRequest(
    method: string,
    handler: JsonRpcServerRequestHandler,
  ): Disposable {
    const previous = this.serverRequestHandlers.get(method);
    this.serverRequestHandlers.set(method, handler);
    return {
      dispose: (): void => {
        if (this.serverRequestHandlers.get(method) === handler) {
          if (previous === undefined) {
            this.serverRequestHandlers.delete(method);
          } else {
            this.serverRequestHandlers.set(method, previous);
          }
        }
      },
    };
  }

  public onServerNotification(
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    const previous = this.serverNotificationHandlers.get(method);
    this.serverNotificationHandlers.set(method, handler);
    return {
      dispose: (): void => {
        if (this.serverNotificationHandlers.get(method) === handler) {
          if (previous === undefined) {
            this.serverNotificationHandlers.delete(method);
          } else {
            this.serverNotificationHandlers.set(method, previous);
          }
        }
      },
    };
  }

  public dispose(): void {
    this.terminate(new CodexError("cancelled", { action: "disposeAppServer" }));
  }

  public close(error: CodexError = processError("appServerExit")): void {
    this.terminate(error);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    let decoded: string;
    try {
      decoded = this.decoder.decode(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
        { stream: true },
      );
    } catch {
      this.terminate(protocolError("decodeAppServerMessage", new Error("invalid UTF-8")));
      return;
    }
    this.lineBuffer += decoded;
    this.consumeLines();
  };

  private readonly handleEnd = (): void => {
    if (this.closed) {
      return;
    }
    try {
      this.lineBuffer += this.decoder.decode();
    } catch {
      this.terminate(protocolError("decodeAppServerMessage", new Error("invalid UTF-8")));
      return;
    }
    if (this.lineBuffer.trim() !== "") {
      const finalLine = this.lineBuffer.endsWith("\r")
        ? this.lineBuffer.slice(0, -1)
        : this.lineBuffer;
      this.lineBuffer = "";
      this.handleLine(finalLine);
    }
    if (!this.closed) {
      this.terminate(processError("appServerExit"));
    }
  };

  private readonly handleStreamError = (): void => {
    this.terminate(processError("appServerStream"));
  };

  private readonly handleInputEnd = (): void => {
    this.terminate(processError("appServerInput"));
  };

  private readonly handleDrain = (): void => {
    if (this.closed || this.activeWrite === undefined) {
      return;
    }
    const ticket = this.activeWrite;
    this.input.removeListener("drain", this.handleDrain);
    this.activeWrite = undefined;
    this.settleWrite(ticket);
    this.pumpWrites();
  };

  private consumeLines(): void {
    while (!this.closed) {
      const newlineIndex = this.lineBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      let line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.trim() !== "") {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.terminate(protocolError("parseAppServerMessage", new Error("invalid JSONL message")));
      return;
    }
    if (!isRecord(parsed)) {
      this.terminate(protocolError("parseAppServerMessage", new Error("JSONL message is not an object")));
      return;
    }

    const hasId = hasOwn(parsed, "id");
    const id = parsed.id;
    if (hasId && !isJsonRpcId(id)) {
      this.terminate(protocolError("parseAppServerMessage", new Error("invalid JSON-RPC id")));
      return;
    }

    if (typeof parsed.method === "string") {
      if (!hasOnlyKeys(parsed, hasId ? ["id", "method", "params"] : ["method", "params"])) {
        this.terminate(protocolError("parseAppServerMessage", new Error("invalid JSON-RPC request")));
        return;
      }
      if (hasId) {
        this.handleServerRequest(id as JsonRpcId, parsed.method, parsed.params);
      } else {
        this.handleServerNotification(parsed.method, parsed.params);
      }
      return;
    }

    if (hasId) {
      if (!this.isValidResponse(parsed)) {
        this.terminate(protocolError("parseAppServerResponse", new Error("invalid JSON-RPC response")));
        return;
      }
      this.handleResponse(id as JsonRpcId, parsed);
      return;
    }

    this.terminate(protocolError("parseAppServerMessage", new Error("message has no method or id")));
  }

  private isValidResponse(message: Record<string, unknown>): boolean {
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");
    if (hasResult === hasError) {
      return false;
    }
    if (hasResult) {
      return hasOnlyKeys(message, ["id", "result"]);
    }

    if (!hasOnlyKeys(message, ["id", "error"]) || !isRecord(message.error)) {
      return false;
    }
    const error = message.error;
    if (!hasOnlyKeys(error, ["code", "message", "data"])) {
      return false;
    }
    return typeof error.code === "number"
      && Number.isFinite(error.code)
      && typeof error.message === "string";
  }

  private handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    this.cleanupPending(pending);

    if (hasOwn(message, "error")) {
      pending.reject(protocolError(pending.method, new Error("remote JSON-RPC request failed")));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (this.serverRequests.has(id)) {
      this.terminate(protocolError("handleAppServerRequest", new Error("duplicate JSON-RPC id")));
      return;
    }
    this.serverRequests.set(id, { method });
    const handler = this.serverRequestHandlers.get(method);
    if (handler === undefined) {
      this.sendServerError(id, -32601);
      this.serverRequests.delete(id);
      return;
    }

    void Promise.resolve()
      .then(() => handler(params, id))
      .then((result) => {
        this.sendServerResponse(id, result);
      })
      .catch(() => {
        this.sendServerError(id, -32000);
      })
      .finally(() => {
        this.serverRequests.delete(id);
      })
      .catch(() => undefined);
  }

  private handleServerNotification(method: string, params: unknown): void {
    const handler = this.serverNotificationHandlers.get(method);
    if (handler === undefined) {
      return;
    }
    void Promise.resolve()
      .then(() => handler(params))
      .catch((cause: unknown) => {
        this.terminate(protocolError("handleAppServerNotification", cause));
      })
      .catch(() => undefined);
  }

  private sendServerResponse(id: JsonRpcId, result: unknown): void {
    try {
      const ticket = this.enqueueMessage({ id, result });
      void ticket.promise.catch(() => undefined);
    } catch {
      // The stream termination path owns the observable process/protocol failure.
    }
  }

  private sendServerError(id: JsonRpcId, code: number): void {
    try {
      const ticket = this.enqueueMessage({
        id,
        error: { code, message: code === -32601 ? "method not found" : "request failed" },
      });
      void ticket.promise.catch(() => undefined);
    } catch {
      // A failed response write must not escape the stream data callback.
    }
  }

  private cancelPendingRequest(id: JsonRpcId, reason: "cancelled" | "timeout"): void {
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    this.cleanupPending(pending);
    const cancellationError = new CodexError(reason, { action: pending.method });
    if (pending.ticket !== undefined && !pending.ticket.started) {
      this.removeQueuedWrite(pending.ticket, cancellationError);
    } else if (!this.closed) {
      try {
        const ticket = this.enqueueMessage({ method: "$/cancelRequest", params: { id } });
        void ticket.promise.catch(() => undefined);
      } catch {
        // The original cancellation/timeout remains the useful failure.
      }
    }
    pending.reject(cancellationError);
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  private enqueueMessage(message: JsonRpcMessage): WriteTicket {
    if (this.closed) {
      throw processError("sendAppServerMessage");
    }
    let data: string;
    try {
      data = `${JSON.stringify(message)}\n`;
    } catch (cause) {
      throw protocolError("serializeAppServerMessage", cause);
    }

    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const ticket: WriteTicket = {
      data,
      promise,
      resolve,
      reject,
      started: false,
      settled: false,
    };
    this.writeQueue.push(ticket);
    this.pumpWrites();
    return ticket;
  }

  private pumpWrites(): void {
    if (this.closed || this.activeWrite !== undefined) {
      return;
    }
    const ticket = this.writeQueue.shift();
    if (ticket === undefined) {
      return;
    }
    ticket.started = true;
    this.activeWrite = ticket;
    this.input.on("drain", this.handleDrain);
    let accepted: boolean;
    try {
      accepted = this.input.write(ticket.data, "utf8");
    } catch (cause) {
      this.input.removeListener("drain", this.handleDrain);
      this.terminate(processError("writeAppServerMessage", cause));
      return;
    }

    if (accepted && this.activeWrite === ticket) {
      this.input.removeListener("drain", this.handleDrain);
      this.activeWrite = undefined;
      this.settleWrite(ticket);
      queueMicrotask(() => this.pumpWrites());
    }
  }

  private removeQueuedWrite(ticket: WriteTicket, reason: unknown): void {
    const index = this.writeQueue.indexOf(ticket);
    if (index >= 0) {
      this.writeQueue.splice(index, 1);
      this.settleWrite(ticket, reason);
    }
  }

  private settleWrite(ticket: WriteTicket, error?: unknown): void {
    if (ticket.settled) {
      return;
    }
    ticket.settled = true;
    if (error === undefined) {
      ticket.resolve();
    } else {
      ticket.reject(error);
    }
  }

  private removeOwnedListeners(): void {
    this.input.removeListener("error", this.handleStreamError);
    this.input.removeListener("finish", this.handleInputEnd);
    this.input.removeListener("close", this.handleInputEnd);
    this.input.removeListener("drain", this.handleDrain);
    this.output.removeListener("data", this.handleData);
    this.output.removeListener("error", this.handleStreamError);
    this.output.removeListener("end", this.handleEnd);
    this.output.removeListener("close", this.handleEnd);
    this.output.removeListener("drain", this.handleDrain);
  }

  private terminate(error: CodexError): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.removeOwnedListeners();

    for (const pending of this.pendingRequests.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const ticket of this.writeQueue) {
      this.settleWrite(ticket, error);
    }
    this.writeQueue.length = 0;
    if (this.activeWrite !== undefined) {
      this.settleWrite(this.activeWrite, error);
      this.activeWrite = undefined;
    }
    this.serverRequests.clear();
    this.serverRequestHandlers.clear();
    this.serverNotificationHandlers.clear();
    this.lineBuffer = "";
    try {
      this.onDidTerminate?.(error);
    } catch {
      // A termination observer must not escape a stream callback.
    }
  }
}

function validateTimeout(options: JsonlRpcClientOptions | undefined): number {
  const timeout = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (timeout !== Number.POSITIVE_INFINITY && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new RangeError("requestTimeoutMs must be positive or Infinity");
  }
  return timeout;
}
