import type {
  CodexMessage,
  CodexModel,
  CodexRequest,
  MessagePart,
  ToolResultPart,
} from "../../core/types.js";
import {
  isCodexReasoningEffort,
  resolveEffectiveReasoningEffort,
} from "../../core/model-effort.js";

type ResponsesInputItem = Record<string, unknown>;

export type ChatGptReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatGptRequestOverrides {
  reasoningEffort?: ChatGptReasoningEffort;
  serviceTier?: "priority";
}

const CHATGPT_REASONING_EFFORTS = new Set<unknown>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function resolveChatGptRequestOverrides(
  reasoningEffort: unknown,
  speedMode: unknown,
): ChatGptRequestOverrides {
  return {
    ...(CHATGPT_REASONING_EFFORTS.has(reasoningEffort)
      ? { reasoningEffort: reasoningEffort as ChatGptReasoningEffort }
      : {}),
    ...(speedMode === "fast" ? { serviceTier: "priority" as const } : {}),
  };
}

const toDataUrl = (mimeType: string, data: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;

const toMessageContent = (
  role: CodexMessage["role"],
  part: Extract<MessagePart, { kind: "text" | "image" }>,
): Record<string, unknown> => {
  if (part.kind === "text") {
    return {
      type: role === "assistant" ? "output_text" : "input_text",
      text: part.text,
    };
  }

  return {
    type: "input_image",
    image_url: toDataUrl(part.mimeType, part.data),
  };
};

const toToolResultContent = (part: ToolResultPart): Record<string, unknown> => {
  if (part.kind === "text") {
    return { type: "input_text", text: part.text };
  }

  return {
    type: "input_image",
    image_url: toDataUrl(part.mimeType, part.data),
  };
};

const flushMessage = (
  input: ResponsesInputItem[],
  role: CodexMessage["role"],
  content: Record<string, unknown>[],
): void => {
  if (content.length === 0) {
    return;
  }

  input.push({ type: "message", role, content: [...content] });
  content.length = 0;
};

const toMessageItems = (message: CodexMessage): ResponsesInputItem[] => {
  const input: ResponsesInputItem[] = [];
  const content: Record<string, unknown>[] = [];

  for (const part of message.parts) {
    if (part.kind === "text" || part.kind === "image") {
      content.push(toMessageContent(message.role, part));
      continue;
    }

    flushMessage(input, message.role, content);

    if (part.kind === "tool-call") {
      input.push({
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.input) ?? "null",
      });
      continue;
    }

    const output = part.content.map(toToolResultContent);
    const allText = part.content.every((result) => result.kind === "text");
    input.push({
      type: "function_call_output",
      call_id: part.callId,
      output: allText
        ? part.content.map((result) => result.kind === "text" ? result.text : "").join("")
        : output,
    });
  }

  flushMessage(input, message.role, content);
  return input;
};

export function buildResponsesRequest(
  request: CodexRequest,
  modelMetadata: CodexModel,
  overrides: ChatGptRequestOverrides = {},
): Record<string, unknown> {
  // Priority: Copilot picker selection (modelOptions) > per-model default
  // > global `copilotCodex.chatgpt.reasoningEffort` setting.
  const effectiveEffort = resolveEffectiveReasoningEffort(
    request.reasoningEffort,
    modelMetadata.id,
    overrides.reasoningEffort,
  );
  return {
    model: modelMetadata.id,
    instructions: request.instructions,
    input: request.messages.flatMap(toMessageItems),
    stream: true,
    store: false,
    // Matches the Codex CLI / opencode behavior: request reasoning summaries
    // and encrypted reasoning replay so follow-up turns in a stateless
    // (`store: false`) conversation can carry reasoning state.
    include: ["reasoning.encrypted_content"],
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
    parallel_tool_calls: modelMetadata.capabilities.parallelToolCalls,
    tool_choice: request.toolMode === "required" ? "required" : "auto",
    ...(effectiveEffort === undefined
      ? {}
      : { reasoning: { effort: effectiveEffort, summary: "auto" } }),
    ...(overrides.serviceTier === undefined
      ? {}
      : { service_tier: overrides.serviceTier }),
  };
}
