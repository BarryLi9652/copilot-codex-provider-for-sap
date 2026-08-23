import { CodexError } from "../../core/errors.js";
import { ModelCache } from "../../core/model-cache.js";
import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "../../core/types.js";
import {
  ChatGptHttpClient,
  type ChatGptFetch,
  type ChatGptHttpClientOptions,
  type ChatGptTokenSource,
} from "./http-client.js";
import { parseChatGptModels } from "./model-catalog.js";
import {
  buildResponsesRequest,
  type ChatGptRequestOverrides,
} from "./request-codec.js";
import {
  ResponsesSseParser,
  type ResponsesSseLogger,
} from "./sse-parser.js";

const MODEL_CACHE_TTL_MS = 300_000;

interface ActiveOperation {
  readonly signal: AbortSignal;
  abort(): void;
  close(): Promise<void>;
  attachCloser(closer: () => Promise<void>): void;
  finish(): void;
  readonly done: Promise<void>;
}

export interface ChatGptOAuthTransportOptions extends ChatGptHttpClientOptions {
  modelCache?: ModelCache;
  logger?: ResponsesSseLogger;
  httpClient?: ChatGptHttpClient;
  requestOverrides?: () => ChatGptRequestOverrides;
}

export class ChatGptOAuthTransport implements CodexTransport {
  private readonly modelCache: ModelCache;
  private readonly httpClient: ChatGptHttpClient;
  private readonly lifecycleController = new AbortController();
  private readonly activeOperations = new Set<ActiveOperation>();
  private disposed = false;

  public constructor(
    tokenSource: ChatGptTokenSource,
    options: ChatGptOAuthTransportOptions = {},
  ) {
    this.modelCache = options.modelCache ?? new ModelCache(MODEL_CACHE_TTL_MS);
    this.httpClient = options.httpClient ?? new ChatGptHttpClient(tokenSource, options);
    this.logger = options.logger;
    this.requestOverrides = options.requestOverrides;
  }

  private readonly logger: ResponsesSseLogger | undefined;
  private readonly requestOverrides: (() => ChatGptRequestOverrides) | undefined;

  public async listModels(
    options: { silent: boolean; forceRefresh?: boolean },
    signal: AbortSignal,
  ): Promise<readonly CodexModel[]> {
    if (signal.aborted) {
      throw new CodexError("cancelled");
    }
    const operation = this.beginOperation(signal);
    try {
      if (options.forceRefresh) {
        this.modelCache.clear();
      }
      return await this.modelCache.get(() => this.loadModels(operation.signal));
    } finally {
      operation.finish();
    }
  }

  public generate(
    request: CodexRequest,
    signal: AbortSignal,
  ): AsyncIterable<TransportEvent> {
    if (this.disposed) {
      throw new CodexError("incompatible", { action: "restartExtension" });
    }
    const operation = this.beginOperation(signal);
    const source = this.generateEvents(request, operation);
    const iterator = source[Symbol.asyncIterator]();
    operation.attachCloser(async () => {
      await iterator.return?.();
    });

    const wrapped: AsyncIterableIterator<TransportEvent> = {
      next: (value?: unknown) => iterator.next(value),
      return: async (_value?: unknown) => {
        await operation.close();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<TransportEvent> {
        return this;
      },
    };
    return wrapped;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleController.abort();
    const active = [...this.activeOperations];
    this.modelCache.clear();
    await Promise.allSettled(active.map((operation) => operation.close()));
    await Promise.allSettled(active.map((operation) => operation.done));
  }

  private async loadModels(signal: AbortSignal): Promise<readonly CodexModel[]> {
    const payload = await this.httpClient.getModels(signal);
    const models = parseChatGptModels(payload);
    if (models.length === 0) {
      throw new CodexError("protocol", { action: "showDiagnostics" });
    }
    return models;
  }

  private async *generateEvents(
    request: CodexRequest,
    operation: ActiveOperation,
  ): AsyncIterable<TransportEvent> {
    try {
      const models = await this.modelCache.get(() => this.loadModels(operation.signal));
      if (operation.signal.aborted) {
        throw new CodexError("cancelled");
      }

      const model = models.find((candidate) => candidate.id === request.modelId);
      if (model === undefined) {
        throw new CodexError("incompatible", { action: "refreshModels" });
      }

      const parser = new ResponsesSseParser(this.logger);
      const body = buildResponsesRequest(request, model, this.requestOverrides?.());
      let completed = false;
      for await (const chunk of this.httpClient.streamResponses(body, operation.signal)) {
        if (operation.signal.aborted) {
          throw new CodexError("cancelled");
        }
        for (const event of parser.push(chunk)) {
          completed ||= event.type === "completed";
          yield event;
        }
      }

      if (operation.signal.aborted) {
        throw new CodexError("cancelled");
      }
      for (const event of parser.finish()) {
        completed ||= event.type === "completed";
        yield event;
      }
      if (!completed) {
        throw new CodexError("protocol", { action: "showDiagnostics" });
      }
    } finally {
      operation.finish();
    }
  }

  private beginOperation(parentSignal: AbortSignal): ActiveOperation {
    if (this.disposed) {
      throw new CodexError("incompatible", { action: "restartExtension" });
    }

    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let finished = false;
    let closer: (() => Promise<void>) | undefined;
    let closePromise: Promise<void> | undefined;
    const abort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    const onParentAbort = (): void => abort();
    const onLifecycleAbort = (): void => abort();
    const operation: ActiveOperation = {
      signal: controller.signal,
      abort,
      close: () => {
        if (closePromise !== undefined) {
          return closePromise;
        }
        closePromise = (async () => {
          abort();
          if (closer !== undefined) {
            try {
              await closer();
            } catch {
              // Iterator close errors must not replace the primary safe error.
            } finally {
              operation.finish();
            }
          }
          await done;
        })();
        return closePromise;
      },
      attachCloser: (candidate) => {
        closer = candidate;
      },
      done,
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        parentSignal.removeEventListener("abort", onParentAbort);
        this.lifecycleController.signal.removeEventListener("abort", onLifecycleAbort);
        this.activeOperations.delete(operation);
        resolveDone();
      },
    };

    this.activeOperations.add(operation);
    if (parentSignal.aborted || this.lifecycleController.signal.aborted) {
      abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      this.lifecycleController.signal.addEventListener("abort", onLifecycleAbort, { once: true });
    }
    return operation;
  }
}

export type { ChatGptFetch } from "./http-client.js";
