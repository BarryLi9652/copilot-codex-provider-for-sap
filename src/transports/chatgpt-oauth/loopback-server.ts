import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  CHATGPT_CALLBACK_HOST,
  CHATGPT_CALLBACK_TIMEOUT_MS,
  CHATGPT_CODEX_PROFILE,
  CHATGPT_REDIRECT_HOST,
} from "./profile.js";

export interface LoopbackServerHandle {
  readonly port: number;
  readonly redirectUri: string;
  readonly callback: Promise<string>;
  close(reason?: Error): Promise<void>;
}

export interface LoopbackServer {
  start(expectedState: string): Promise<LoopbackServerHandle>;
}

export interface LoopbackServerOptions {
  ports?: readonly number[];
  timeoutMs?: number;
}

export type LoopbackErrorCode =
  | "callback_timeout"
  | "callback_close_failed"
  | "callback_response_failed";

export class LoopbackError extends Error {
  public readonly code: LoopbackErrorCode;
  public readonly primaryError: Error | undefined;

  public constructor(
    code: LoopbackErrorCode,
    message: string,
    cause?: unknown,
    primaryError?: Error,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LoopbackError";
    this.code = code;
    this.primaryError = primaryError;
  }
}

const staticPage = (heading: string, message: string): string => {
  const escapeHtml = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    heading,
  )}</title></head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(
    message,
  )}</p></body></html>`;
};

const writeResponse = (
  response: ServerResponse,
  status: number,
  heading: string,
  message: string,
  headers: Record<string, string> = {},
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(staticPage(heading, message));
};

const isAddressInUse = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "EADDRINUSE";

const serverError = (message: string, cause?: unknown): Error => {
  const error = new Error(message);
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  }
  return error;
};

const asError = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : serverError(fallback, value);

const closeError = (cause: unknown): LoopbackError =>
  cause instanceof LoopbackError && cause.code === "callback_close_failed"
    ? cause
    : new LoopbackError(
        "callback_close_failed",
        "The OAuth callback server could not be closed.",
        cause,
      );

const responseError = (cause: unknown): LoopbackError =>
  new LoopbackError(
    "callback_response_failed",
    "The OAuth callback response could not be written.",
    cause,
  );

export class LoopbackCallbackServer implements LoopbackServer {
  private readonly ports: readonly number[];
  private readonly timeoutMs: number;

  public constructor(options: LoopbackServerOptions = {}) {
    this.ports = options.ports ?? CHATGPT_CODEX_PROFILE.callbackPorts;
    this.timeoutMs = options.timeoutMs ?? CHATGPT_CALLBACK_TIMEOUT_MS;
  }

  public async start(expectedState: string): Promise<LoopbackServerHandle> {
    let lastAddressError: unknown;
    for (const port of this.ports) {
      try {
        return await this.listen(port, expectedState);
      } catch (error) {
        if (!isAddressInUse(error)) {
          throw error;
        }
        lastAddressError = error;
      }
    }

    throw serverError("No OAuth loopback callback port is available.", lastAddressError);
  }

  private listen(port: number, expectedState: string): Promise<LoopbackServerHandle> {
    return new Promise((resolve, reject) => {
      let actualPort: number | undefined;
      let callbackSettled = false;
      let closed = false;
      let closePromise: Promise<void> | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let resolveCallback!: (url: string) => void;
      let rejectCallback!: (error: Error) => void;
      let handle!: LoopbackServerHandle;

      const callback = new Promise<string>((callbackResolve, callbackReject) => {
        resolveCallback = callbackResolve;
        rejectCallback = callbackReject;
      });

      const closeServer = (): Promise<void> => {
        if (closePromise) {
          return closePromise;
        }
        closed = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        closePromise = new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
              closeReject(closeError(error));
              return;
            }
            closeResolve();
          });
        });
        return closePromise;
      };

      const settleCallbackAfterClose = async (
        callbackUrl: string | undefined,
        primaryError: Error | undefined,
        response?: ServerResponse,
      ): Promise<void> => {
        let terminalError = primaryError;
        if (response !== undefined) {
          try {
            writeResponse(
              response,
              200,
              "OAuth callback received",
              "You may close this window.",
            );
          } catch (error) {
            terminalError = responseError(error);
            try {
              response.destroy();
            } catch (destroyError) {
              terminalError = new LoopbackError(
                "callback_response_failed",
                terminalError.message,
                { writeError: error, destroyError },
              );
            }
          }
        }

        try {
          await closeServer();
        } catch (error) {
          const failure = closeError(error);
          rejectCallback(
            terminalError === undefined
              ? failure
              : new LoopbackError(
                  "callback_close_failed",
                  failure.message,
                  failure,
                  terminalError,
                ),
          );
          return;
        }
        if (terminalError === undefined) {
          resolveCallback(callbackUrl as string);
        } else {
          rejectCallback(terminalError);
        }
      };

      const runTerminal = (
        callbackUrl: string | undefined,
        primaryError: Error | undefined,
        response?: ServerResponse,
      ): void => {
        void settleCallbackAfterClose(callbackUrl, primaryError, response).catch(
          (error: unknown) => {
            rejectCallback(closeError(error));
          },
        );
      };

      const closeHandle = async (reason?: Error): Promise<void> => {
        let failure: LoopbackError | undefined;
        try {
          await closeServer();
        } catch (error) {
          failure = closeError(error);
        }

        if (!callbackSettled) {
          callbackSettled = true;
          if (failure) {
            rejectCallback(
              reason === undefined
                ? failure
                : new LoopbackError(
                    "callback_close_failed",
                    failure.message,
                    failure,
                    reason,
                  ),
            );
          } else {
            rejectCallback(reason ?? serverError("OAuth callback server closed."));
          }
        }

        if (failure) {
          throw failure;
        }
      };

      const acceptCallback = (request: IncomingMessage, response: ServerResponse): void => {
        if (request.method !== "GET") {
          writeResponse(response, 405, "Method not allowed", "Use the OAuth callback link in your browser.", {
            allow: "GET",
          });
          return;
        }
        if (request.url === undefined) {
          writeResponse(response, 400, "Invalid callback", "The OAuth callback was not valid.");
          return;
        }

        let callbackUrl: URL;
        try {
          callbackUrl = new URL(
            request.url,
            `http://${CHATGPT_REDIRECT_HOST}:${actualPort}${CHATGPT_CODEX_PROFILE.callbackPath}`,
          );
        } catch {
          writeResponse(response, 400, "Invalid callback", "The OAuth callback was not valid.");
          return;
        }

        if (
          callbackUrl.origin !== `http://${CHATGPT_REDIRECT_HOST}:${actualPort}` ||
          callbackUrl.pathname !== CHATGPT_CODEX_PROFILE.callbackPath ||
          callbackUrl.hash
        ) {
          writeResponse(response, 404, "Not found", "The OAuth callback was not valid.");
          return;
        }
        if (callbackSettled || closed) {
          writeResponse(response, 409, "Callback already handled", "The OAuth callback was already handled.");
          return;
        }

        const states = callbackUrl.searchParams.getAll("state");
        if (states.length !== 1 || states[0] === "" || states[0] !== expectedState) {
          writeResponse(response, 400, "Invalid callback", "The OAuth callback state was not valid.");
          return;
        }

        callbackSettled = true;
        runTerminal(callbackUrl.toString(), undefined, response);
      };

      const server: Server = createServer(acceptCallback);
      server.once("error", (error) => {
        if (actualPort === undefined) {
          reject(error);
          return;
        }
        if (!closed && !callbackSettled) {
          callbackSettled = true;
          runTerminal(undefined, asError(error, "OAuth callback server failed."));
        }
      });
      server.once("listening", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          const listenerError = serverError("OAuth callback listener did not expose an address.");
          void closeServer().then(
            () => reject(listenerError),
            (error: unknown) =>
              reject(
                new LoopbackError(
                  "callback_close_failed",
                  listenerError.message,
                  error,
                  listenerError,
                ),
              ),
          );
          return;
        }
        actualPort = address.port;
        const redirectUri = `http://${CHATGPT_REDIRECT_HOST}:${actualPort}${CHATGPT_CODEX_PROFILE.callbackPath}`;
        handle = {
          port: actualPort,
          redirectUri,
          callback,
          close: closeHandle,
        };
        timeout = setTimeout(() => {
          const error = new LoopbackError(
            "callback_timeout",
            "OAuth callback server timed out.",
          );
          if (!callbackSettled && !closed) {
            callbackSettled = true;
            runTerminal(undefined, error);
          }
        }, this.timeoutMs);
        resolve(handle);
      });
      server.listen(port, CHATGPT_CALLBACK_HOST);
    });
  }
}
