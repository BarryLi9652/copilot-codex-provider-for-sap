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
  start(): Promise<LoopbackServerHandle>;
}

export interface LoopbackServerOptions {
  ports?: readonly number[];
  timeoutMs?: number;
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

export class LoopbackCallbackServer implements LoopbackServer {
  private readonly ports: readonly number[];
  private readonly timeoutMs: number;

  public constructor(options: LoopbackServerOptions = {}) {
    this.ports = options.ports ?? CHATGPT_CODEX_PROFILE.callbackPorts;
    this.timeoutMs = options.timeoutMs ?? CHATGPT_CALLBACK_TIMEOUT_MS;
  }

  public async start(): Promise<LoopbackServerHandle> {
    let lastAddressError: unknown;
    for (const port of this.ports) {
      try {
        return await this.listen(port);
      } catch (error) {
        if (!isAddressInUse(error)) {
          throw error;
        }
        lastAddressError = error;
      }
    }

    throw serverError("No OAuth loopback callback port is available.", lastAddressError);
  }

  private listen(port: number): Promise<LoopbackServerHandle> {
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

      const closeServer = (reason?: Error): Promise<void> => {
        if (closePromise) {
          return closePromise;
        }
        closed = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (!callbackSettled) {
          callbackSettled = true;
          rejectCallback(reason ?? serverError("OAuth callback server closed."));
        }
        closePromise = new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
              closeReject(error);
              return;
            }
            closeResolve();
          });
        });
        return closePromise;
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

        callbackSettled = true;
        resolveCallback(callbackUrl.toString());
        writeResponse(response, 200, "OAuth callback received", "You may close this window.");
        void closeServer();
      };

      const server: Server = createServer(acceptCallback);
      server.once("error", (error) => {
        if (actualPort === undefined) {
          reject(error);
          return;
        }
        if (!closed) {
          void closeServer(error).catch(() => undefined);
        }
      });
      server.once("listening", () => {
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          void closeServer(serverError("OAuth callback listener did not expose an address.")).catch(
            () => undefined,
          );
          reject(serverError("OAuth callback listener did not expose an address."));
          return;
        }
        actualPort = address.port;
        const redirectUri = `http://${CHATGPT_REDIRECT_HOST}:${actualPort}${CHATGPT_CODEX_PROFILE.callbackPath}`;
        handle = {
          port: actualPort,
          redirectUri,
          callback,
          close: closeServer,
        };
        timeout = setTimeout(() => {
          const error = serverError("OAuth callback server timed out.");
          if (!callbackSettled) {
            callbackSettled = true;
            rejectCallback(error);
          }
          void closeServer(error).catch(() => undefined);
        }, this.timeoutMs);
        resolve(handle);
      });
      server.listen(port, CHATGPT_CALLBACK_HOST);
    });
  }
}
