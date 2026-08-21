import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { toAbortSignal } from "../core/cancellation.js";
import { CodexError, withProviderRecoveryAction } from "../core/errors.js";
import { ModelCache } from "../core/model-cache.js";
import type {
  CodexModel,
  CodexTransport,
  TransportEvent,
} from "../core/types.js";
import { toCodexRequest } from "./message-adapter.js";
import { reportTransportEvent } from "./response-adapter.js";
import { countTokens } from "./token-count.js";
import { SapContextProvider } from "../sap/context.js";
import { buildSapInstructions } from "../sap/instructions.js";

const MODEL_CACHE_TTL_MS = 300_000;

export interface CodexLanguageModelProviderOptions {
  modelCache?: ModelCache;
  requestIdFactory?: () => string;
  instructions?: string;
  sapContextProvider?: SapContextProvider;
}

const isCancelledError = (error: unknown): boolean =>
  error instanceof CodexError && error.code === "cancelled";

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError" ||
  error instanceof Error && error.name === "AbortError";

function waitForCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }

  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const mapModel = (model: CodexModel): vscode.LanguageModelChatInformation => ({
  id: model.id,
  name: model.name,
  family: model.family,
  version: model.version,
  maxInputTokens: model.maxInputTokens,
  maxOutputTokens: model.maxOutputTokens,
  capabilities: {
    imageInput: model.capabilities.imageInput,
    toolCalling: model.capabilities.toolCalling,
  },
});

export class CodexLanguageModelProvider implements vscode.LanguageModelChatProvider {
  private readonly modelCache: ModelCache;
  private readonly requestIdFactory: () => string;
  private readonly instructions: string;
  private readonly sapContextProvider: SapContextProvider;

  public constructor(
    private readonly transport: CodexTransport,
    vendorOrOptions: string | CodexLanguageModelProviderOptions = "",
    options: CodexLanguageModelProviderOptions = {},
  ) {
    const resolvedOptions = typeof vendorOrOptions === "string" ? options : vendorOrOptions;
    this.modelCache = resolvedOptions.modelCache ?? new ModelCache(MODEL_CACHE_TTL_MS);
    this.requestIdFactory = resolvedOptions.requestIdFactory ?? randomUUID;
    this.instructions = resolvedOptions.instructions ?? "";
    this.sapContextProvider = resolvedOptions.sapContextProvider ?? new SapContextProvider();
  }

  public async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const binding = toAbortSignal(token);
    try {
      if (binding.signal.aborted) {
        return [];
      }
      const models = await waitForCancellation(
        this.modelCache.get(() =>
          this.transport.listModels({ silent: options.silent }, new AbortController().signal)),
        binding.signal,
      );
      if (models === undefined) {
        return [];
      }
      return models.map(mapModel);
    } catch (error: unknown) {
      if (binding.signal.aborted || isCancelledError(error) || isAbortError(error)) {
        return [];
      }
      if (error instanceof CodexError) {
        throw withProviderRecoveryAction(error);
      }
      throw error;
    } finally {
      binding.dispose();
    }
  }

  public async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const binding = toAbortSignal(token);

    try {
      const request = toCodexRequest({
        requestId: this.requestIdFactory(),
        model,
        messages,
        options,
        instructions: [
          this.instructions,
          buildSapInstructions(
            this.sapContextProvider.collect(),
            (options.tools ?? []).map((tool) => tool.name),
          ),
        ].filter((instructions) => instructions.length > 0).join("\n\n"),
      });
      for await (const event of this.transport.generate(request, binding.signal)) {
        if (binding.signal.aborted) {
          return;
        }
        reportTransportEvent(event, progress);
      }
    } catch (error: unknown) {
      if (binding.signal.aborted || isCancelledError(error) || isAbortError(error)) {
        return;
      }
      if (error instanceof CodexError) {
        throw withProviderRecoveryAction(error);
      }
      throw error;
    } finally {
      binding.dispose();
    }
  }

  public provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(countTokens(text));
  }
}
