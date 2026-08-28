import * as vscode from "vscode";

import type {
  CodexMessage,
  CodexRequest,
  JsonObject,
  MessagePart,
  ToolResultPart,
  ToolSpec,
} from "../core/types.js";

export interface ToCodexRequestInput {
  requestId: string;
  model: vscode.LanguageModelChatInformation;
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  options: vscode.ProvideLanguageModelChatResponseOptions;
  instructions?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toImagePart = (part: vscode.LanguageModelDataPart): MessagePart | undefined => {
  if (!part.mimeType.startsWith("image/")) {
    return undefined;
  }

  return {
    kind: "image",
    mimeType: part.mimeType,
    data: part.data,
  };
};

const toToolResultPart = (
  part: vscode.LanguageModelTextPart | vscode.LanguageModelDataPart | unknown,
): ToolResultPart | undefined => {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { kind: "text", text: part.value };
  }

  if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
    return {
      kind: "image",
      mimeType: part.mimeType,
      data: part.data,
    };
  }

  return undefined;
};

const toMessagePart = (
  part: vscode.LanguageModelInputPart | unknown,
): MessagePart | undefined => {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { kind: "text", text: part.value };
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return toImagePart(part);
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return {
      kind: "tool-call",
      callId: part.callId,
      name: part.name,
      input: part.input,
    };
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const content = part.content
      .map(toToolResultPart)
      .filter((result): result is ToolResultPart => result !== undefined);
    return {
      kind: "tool-result",
      callId: part.callId,
      content,
    };
  }

  return undefined;
};

export function toCodexMessage(
  message: vscode.LanguageModelChatRequestMessage,
): CodexMessage {
  const parts = message.content
    .map(toMessagePart)
    .filter((part): part is MessagePart => part !== undefined);

  return {
    role: message.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
    ...(message.name === undefined ? {} : { name: message.name }),
    parts,
  };
}

const toToolSpec = (tool: vscode.LanguageModelChatTool): ToolSpec => ({
  name: tool.name,
  description: tool.description,
  inputSchema: isObject(tool.inputSchema) ? tool.inputSchema as JsonObject : {},
});

const toCodexRequestFromInput = (input: ToCodexRequestInput): CodexRequest => {
  const modelOptions = (input.options as { modelOptions?: Record<string, unknown> }).modelOptions;
  const reasoningEffort = modelOptions?.reasoningEffort;
  return {
    requestId: input.requestId,
    modelId: input.model.id,
    messages: input.messages.map(toCodexMessage),
    tools: (input.options.tools ?? []).map(toToolSpec),
    toolMode: input.options.toolMode === vscode.LanguageModelChatToolMode.Required
      ? "required"
      : "auto",
    instructions: input.instructions ?? "",
    ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
  };
};

export function toCodexRequest(input: ToCodexRequestInput): CodexRequest;
export function toCodexRequest(
  requestId: string,
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  instructions?: string,
): CodexRequest;
export function toCodexRequest(
  inputOrRequestId: ToCodexRequestInput | string,
  model?: vscode.LanguageModelChatInformation,
  messages?: readonly vscode.LanguageModelChatRequestMessage[],
  options?: vscode.ProvideLanguageModelChatResponseOptions,
  instructions?: string,
): CodexRequest {
  if (typeof inputOrRequestId !== "string") {
    return toCodexRequestFromInput(inputOrRequestId);
  }

  if (model === undefined || messages === undefined || options === undefined) {
    throw new TypeError("model, messages, and options are required");
  }

  return toCodexRequestFromInput({
    requestId: inputOrRequestId,
    model,
    messages,
    options,
    instructions,
  });
}
