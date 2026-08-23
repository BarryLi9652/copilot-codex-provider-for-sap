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
import { classifySapTools } from "../sap/tool-capabilities.js";

const MODEL_CACHE_TTL_MS = 300_000;
const MAX_TOOL_COUNT = 128;
const VIRTUAL_TOOL_ACTIVATOR_PREFIX = "activate_";
const PREFLIGHT_CALL_ID_PREFIX = "copilot_codex_preflight_";

type CodexLanguageModelChatInformation = vscode.LanguageModelChatInformation & {
  readonly isBYOK: true;
};

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

const virtualActivatorCapabilityText = (tool: vscode.LanguageModelChatTool): string => [
  tool.name.slice(VIRTUAL_TOOL_ACTIVATOR_PREFIX.length),
  tool.description,
  JSON.stringify(tool.inputSchema ?? {}),
].join(" ").toLowerCase();

const selectSapVirtualToolActivators = (
  tools: readonly vscode.LanguageModelChatTool[],
): readonly vscode.LanguageModelChatTool[] => {
  const capabilities = classifySapTools(tools.map((tool) => tool.name));
  const needsEdit = capabilities.edit.length === 0;
  const needsActivate = capabilities.activate.length === 0;

  return tools.filter((tool) => {
    if (!tool.name.startsWith(VIRTUAL_TOOL_ACTIVATOR_PREFIX)) {
      return false;
    }
    const capability = virtualActivatorCapabilityText(tool);
    return (needsEdit && /\b(edit|editing|replace|write|writing)\b/u.test(capability))
      || (needsActivate && /\b(activate|activation)\b/u.test(capability));
  });
};

const isPreflightPart = (part: unknown): boolean =>
  (part instanceof vscode.LanguageModelToolCallPart
    || part instanceof vscode.LanguageModelToolResultPart)
  && part.callId.startsWith(PREFLIGHT_CALL_ID_PREFIX);

const filterPreflightMessages = (
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): readonly vscode.LanguageModelChatRequestMessage[] => messages.flatMap((message) => {
  const content = message.content.filter((part) => !isPreflightPart(part));
  return content.length === 0 ? [] : [{ ...message, content }];
});

const hasCurrentTurnPreflight = (
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean => {
  let latestHumanUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === vscode.LanguageModelChatMessageRole.User
      && message.content.some((part) => !(part instanceof vscode.LanguageModelToolResultPart))) {
      latestHumanUserMessageIndex = index;
      break;
    }
  }

  return messages.slice(latestHumanUserMessageIndex + 1)
    .some((message) => message.content.some(isPreflightPart));
};

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

const mapModel = (model: CodexModel): CodexLanguageModelChatInformation => ({
  id: model.id,
  name: model.name.replace(/^gpt(?:[\s-]+|$)/iu, "Codex ").trim(),
  family: model.family,
  version: model.version,
  maxInputTokens: model.maxInputTokens,
  maxOutputTokens: model.maxOutputTokens,
  isBYOK: true,
  capabilities: {
    imageInput: model.capabilities.imageInput,
    toolCalling: model.capabilities.toolCalling ? MAX_TOOL_COUNT : false,
  },
});

export class CodexLanguageModelProvider implements vscode.LanguageModelChatProvider {
  private readonly modelCache: ModelCache;
  private readonly modelInformationChanged = new vscode.EventEmitter<void>();
  private readonly requestIdFactory: () => string;
  private readonly instructions: string;
  private readonly sapContextProvider: SapContextProvider;
  public readonly onDidChangeLanguageModelChatInformation =
    this.modelInformationChanged.event;

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

  public invalidateModelInformation(): void {
    this.modelCache.clear();
    this.modelInformationChanged.fire();
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
      const requestId = this.requestIdFactory();
      const sapContext = this.sapContextProvider.collect();
      const preflightTools = !binding.signal.aborted
        && sapContext.activeDocument?.uri.startsWith("adt://") === true
        && !hasCurrentTurnPreflight(messages)
        ? selectSapVirtualToolActivators(options.tools ?? [])
        : [];
      if (preflightTools.length > 0) {
        preflightTools.forEach((tool, index) => progress.report(
          new vscode.LanguageModelToolCallPart(
            `${PREFLIGHT_CALL_ID_PREFIX}${requestId}_${index}`,
            tool.name,
            {},
          ),
        ));
        return;
      }
      const request = toCodexRequest({
        requestId,
        model,
        messages: filterPreflightMessages(messages),
        options,
        instructions: [
          this.instructions,
          buildSapInstructions(
            sapContext,
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
