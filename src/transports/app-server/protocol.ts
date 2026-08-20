import { CodexError } from "../../core/errors.js";

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | { id: JsonRpcId; method: string; params?: unknown }
  | { id: JsonRpcId; result?: unknown; error?: JsonRpcError }
  | { method: string; params?: unknown };

export type AppServerUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export interface Disposable {
  dispose(): void;
}

export type JsonRpcServerRequestHandler = (
  params: unknown,
  id: JsonRpcId,
) => unknown | Promise<unknown>;

export type JsonRpcServerNotificationHandler = (
  params: unknown,
) => void | Promise<void>;

export class JsonRpcRemoteError extends Error {
  public readonly rpcCode: number;
  public readonly rpcMessage: string;

  public constructor(code: number, message: string) {
    super("remote JSON-RPC request failed");
    this.name = "JsonRpcRemoteError";
    this.rpcCode = code;
    this.rpcMessage = message;
    Object.defineProperty(this, "rpcCode", { enumerable: false });
    Object.defineProperty(this, "rpcMessage", { enumerable: false });
  }
}

export function protocolError(action: string, cause?: unknown): CodexError {
  return new CodexError("protocol", { action, cause });
}

export function processError(action: string, cause?: unknown): CodexError {
  return new CodexError("process", { action, cause });
}
