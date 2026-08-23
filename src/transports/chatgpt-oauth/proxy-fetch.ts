import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type ProxyEnv,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
} from "node:https";
import { Readable } from "node:stream";

import type {
  ChatGptFetch,
  ChatGptHttpResponse,
  ChatGptRequestInit,
} from "./http-client.js";

const selectProxyEnv = (environment: NodeJS.ProcessEnv): ProxyEnv => {
  const httpProxy = environment.HTTP_PROXY ?? environment.http_proxy;
  const httpsProxy = environment.HTTPS_PROXY ?? environment.https_proxy;
  const noProxy = environment.NO_PROXY ?? environment.no_proxy;
  return {
    ...(httpProxy === undefined ? {} : { HTTP_PROXY: httpProxy }),
    ...(httpsProxy === undefined ? {} : { HTTPS_PROXY: httpsProxy }),
    ...(noProxy === undefined ? {} : { NO_PROXY: noProxy }),
  };
};

const toHeaders = (message: IncomingMessage): Headers => {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index] ?? "", message.rawHeaders[index + 1] ?? "");
  }
  return headers;
};

const toResponse = (message: IncomingMessage, method: string | undefined): Response => {
  const status = message.statusCode ?? 500;
  const hasBody = method !== "HEAD" && ![101, 204, 205, 304].includes(status);
  const body = hasBody
    ? Readable.toWeb(message) as ReadableStream<Uint8Array>
    : null;
  return new Response(body, {
    status,
    statusText: message.statusMessage,
    headers: toHeaders(message),
  });
};

const createAgent = (url: URL, proxyEnv: ProxyEnv): HttpAgent =>
  url.protocol === "https:"
    ? new HttpsAgent({ proxyEnv })
    : new HttpAgent({ proxyEnv });

const fetchNode = (
  url: URL,
  init: ChatGptRequestInit,
  proxyEnv: ProxyEnv,
): Promise<ChatGptHttpResponse> => new Promise((resolve, reject) => {
  const agent = createAgent(url, proxyEnv);
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const request = requestFn(url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    agent,
  }, (response) => {
    response.once("close", () => agent.destroy());
    try {
      resolve(toResponse(response, init.method));
    } catch (error) {
      agent.destroy();
      reject(error);
    }
  });
  request.once("error", (error) => {
    agent.destroy();
    reject(error);
  });
  request.end(init.body);
});

export const createProxyAwareFetch = (
  environment: NodeJS.ProcessEnv = process.env,
  explicitProxyUrl?: string,
): ChatGptFetch => {
  const normalizedProxyUrl = explicitProxyUrl?.trim();
  const proxyEnv: ProxyEnv = normalizedProxyUrl
    ? { HTTP_PROXY: normalizedProxyUrl, HTTPS_PROXY: normalizedProxyUrl }
    : selectProxyEnv(environment);
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new TypeError(`Unsupported protocol: ${target.protocol}`);
    }
    return fetchNode(target, init, proxyEnv);
  };
};
