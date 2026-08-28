/**
 * Usage reporting for Copilot Chat's session context widget.
 *
 * Copilot Chat (VS Code >= 1.13x, agent-host BYOK bridge) consumes token usage
 * reported by providers through a `LanguageModelDataPart` with the MIME type
 * `usage`. The payload is JSON in the OpenAI usage shape; the bridge decodes
 * `prompt_tokens` / `completion_tokens` (and optional details) from it and
 * feeds the "Session Info" context-window widget.
 *
 * Framework-free (no vscode import) so it stays unit-testable under plain node.
 */

export const COPILOT_USAGE_DATA_PART_MIME_TYPE = "usage";

export interface CopilotUsagePayload {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly prompt_tokens_details: {
    readonly cached_tokens: number;
  };
}

export function buildUsagePayload(
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
): CopilotUsagePayload {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  };
}

export function encodeUsagePayloadJson(payload: CopilotUsagePayload): string {
  return JSON.stringify(payload);
}
