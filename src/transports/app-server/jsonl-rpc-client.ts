import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import { CodexError } from "../../core/errors.js";
import {
  type Disposable,
  type JsonRpcId,
  type JsonRpcMessage,
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
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
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

export class JsonlRpcClient {
  private readonly input: Writable;
  private readonly output: Readable;
  private readonly requestTimeoutMs: number;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly serverRequests = new Map<JsonRpcId, ActiveServerRequest>();
  private readonly serverRequestHandlers = new Map<string, JsonRpcServerRequestHandler>();
  private nextRequestId = 1;
  private lineBuffer = "";
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
      this.requestTimeoutMs = validateTimeout(second as JsonlRpcClientOptions | undefined);
    } else {
      this.output = first;
      this.input = second as Writable;
      this.requestTimeoutMs = validateTimeout(third);
    }

    this.output.on("data", this.handleData);
    this.output.once("end", this.handleEnd);
    this.output.once("close", this.handleEnd);
    this.output.once("error", this.handleStreamError);
    this.input.once("error", this.handleStreamError);
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
      };
      this.pendingRequests.set(id, pending);
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        this.writeMessage({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.pendingRequests.delete(id);
        this.cleanupPending(pending);
        reject(error);
      }
    });
  }

  public notify(method: string, params?: unknown): void {
    this.writeMessage({
      method,
      ...(params === undefined ? {} : { params }),
    });
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
    const decoded = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.lineBuffer += decoded;
    this.consumeLines();
  };

  private readonly handleEnd = (): void => {
    if (this.closed) {
      return;
    }
    this.lineBuffer += this.decoder.end();
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
      if (hasId) {
        this.handleServerRequest(id as JsonRpcId, parsed.method, parsed.params);
      }
      return;
    }

    if (hasId) {
      this.handleResponse(id as JsonRpcId, parsed);
      return;
    }

    this.terminate(protocolError("parseAppServerMessage", new Error("message has no method or id")));
  }

  private handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    this.cleanupPending(pending);

    if (hasOwn(message, "error")) {
      const remoteError = message.error;
      if (!isRecord(remoteError) || typeof remoteError.code !== "number") {
        pending.reject(protocolError("parseAppServerResponse", new Error("invalid JSON-RPC error")));
        return;
      }
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

    Promise.resolve()
      .then(() => handler(params, id))
      .then((result) => {
        if (this.closed) {
          return;
        }
        this.writeMessage({ id, result });
      })
      .catch(() => {
        if (!this.closed) {
          this.sendServerError(id, -32000);
        }
      })
      .finally(() => {
        this.serverRequests.delete(id);
      })
      .catch(() => undefined);
  }

  private sendServerError(id: JsonRpcId, code: number): void {
    if (!this.closed) {
      this.writeMessage({
        id,
        error: { code, message: code === -32601 ? "method not found" : "request failed" },
      });
    }
  }

  private cancelPendingRequest(id: JsonRpcId, reason: "cancelled" | "timeout"): void {
    const pending = this.pendingRequests.get(id);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    this.cleanupPending(pending);
    if (!this.closed) {
      try {
        this.writeMessage({ method: "$/cancelRequest", params: { id } });
      } catch {
        // The original cancellation/timeout is the useful failure.
      }
    }
    pending.reject(new CodexError(reason, { action: pending.method }));
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  private writeMessage(message: JsonRpcMessage): void {
    if (this.closed) {
      throw processError("sendAppServerMessage");
    }
    let encoded: string;
    try {
      encoded = `${JSON.stringify(message)}\n`;
    } catch (cause) {
      throw protocolError("serializeAppServerMessage", cause);
    }
    try {
      this.input.write(encoded, "utf8");
    } catch (cause) {
      const error = processError("writeAppServerMessage", cause);
      this.terminate(error);
      throw error;
    }
  }

  private terminate(error: CodexError): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pendingRequests.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.serverRequests.clear();
  }
}

function validateTimeout(options: JsonlRpcClientOptions | undefined): number {
  const timeout = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (timeout !== Number.POSITIVE_INFINITY && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new RangeError("requestTimeoutMs must be positive or Infinity");
  }
  return timeout;
}
