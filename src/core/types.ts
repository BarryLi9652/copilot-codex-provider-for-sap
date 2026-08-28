export type JsonObject = Readonly<Record<string, unknown>>;

export type ToolResultPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; data: Uint8Array };

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; data: Uint8Array }
  | { kind: "tool-call"; callId: string; name: string; input: unknown }
  | { kind: "tool-result"; callId: string; content: readonly ToolResultPart[] };

export interface CodexMessage {
  role: "user" | "assistant";
  name?: string;
  parts: readonly MessagePart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface CodexModel {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput: boolean; toolCalling: boolean; parallelToolCalls: boolean };
}

export interface CodexRequest {
  requestId: string;
  modelId: string;
  messages: readonly CodexMessage[];
  tools: readonly ToolSpec[];
  toolMode: "auto" | "required";
  instructions: string;
  /**
   * Request-scoped reasoning effort selected in the Copilot model picker
   * (`modelOptions.reasoningEffort`). Takes priority over per-model defaults
   * and the global extension setting.
   */
  reasoningEffort?: string;
}

export type TransportEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | {
    type: "usage";
    inputTokens?: number;
    /**
     * Input tokens served from the prompt cache for this turn
     * (`input_tokens_details.cached_tokens` on the OAuth Responses route,
     * `tokenUsage.*.cachedInputTokens` deltas on the Local CLI route).
     */
    cachedTokens?: number;
    outputTokens?: number;
    /**
     * Full context totals for the current turn when a transport also emits
     * delta-based usage. Local CLI's `thread/tokenUsage/updated` is cumulative
     * for the thread, whereas its input/output event fields are deltas.
     */
    contextInputTokens?: number;
    contextOutputTokens?: number;
  }
  | { type: "completed" };

export interface CodexTransport {
  listModels(
    options: { silent: boolean; forceRefresh?: boolean },
    signal: AbortSignal,
  ): Promise<readonly CodexModel[]>;
  generate(request: CodexRequest, signal: AbortSignal): AsyncIterable<TransportEvent>;
  dispose(): Promise<void>;
}
