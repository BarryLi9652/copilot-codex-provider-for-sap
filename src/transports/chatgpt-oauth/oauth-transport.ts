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
import { buildResponsesRequest } from "./request-codec.js";
import {
  ResponsesSseParser,
  type ResponsesSseLogger,
} from "./sse-parser.js";

const MODEL_CACHE_TTL_MS = 300_000;

export interface ChatGptOAuthTransportOptions extends ChatGptHttpClientOptions {
  modelCache?: ModelCache;
  logger?: ResponsesSseLogger;
  httpClient?: ChatGptHttpClient;
}

export class ChatGptOAuthTransport implements CodexTransport {
  private readonly modelCache: ModelCache;
  private readonly httpClient: ChatGptHttpClient;

  public constructor(
    tokenSource: ChatGptTokenSource,
    options: ChatGptOAuthTransportOptions = {},
  ) {
    this.modelCache = options.modelCache ?? new ModelCache(MODEL_CACHE_TTL_MS);
    this.httpClient = options.httpClient ?? new ChatGptHttpClient(tokenSource, options);
    this.logger = options.logger;
  }

  private readonly logger: ResponsesSseLogger | undefined;

  public async listModels(
    options: { silent: boolean; forceRefresh?: boolean },
    signal: AbortSignal,
  ): Promise<readonly CodexModel[]> {
    if (options.forceRefresh) {
      this.modelCache.clear();
    }
    if (signal.aborted) {
      throw new CodexError("cancelled");
    }
    return this.modelCache.get(() => this.loadModels(signal));
  }

  public generate(
    request: CodexRequest,
    signal: AbortSignal,
  ): AsyncIterable<TransportEvent> {
    return this.generateEvents(request, signal);
  }

  public async dispose(): Promise<void> {
    this.modelCache.clear();
  }

  private async loadModels(signal: AbortSignal): Promise<readonly CodexModel[]> {
    const payload = await this.httpClient.getModels(signal);
    return parseChatGptModels(payload);
  }

  private async *generateEvents(
    request: CodexRequest,
    signal: AbortSignal,
  ): AsyncIterable<TransportEvent> {
    const models = await this.modelCache.get(() => this.loadModels(signal));
    if (signal.aborted) {
      throw new CodexError("cancelled");
    }

    const model = models.find((candidate) => candidate.id === request.modelId);
    if (model === undefined) {
      throw new CodexError("incompatible", { action: "refreshModels" });
    }

    const parser = new ResponsesSseParser(this.logger);
    const body = buildResponsesRequest(request, model);
    for await (const chunk of this.httpClient.streamResponses(body, signal)) {
      if (signal.aborted) {
        throw new CodexError("cancelled");
      }
      yield* parser.push(chunk);
    }

    if (signal.aborted) {
      throw new CodexError("cancelled");
    }
    yield* parser.finish();
  }
}

export type { ChatGptFetch } from "./http-client.js";
