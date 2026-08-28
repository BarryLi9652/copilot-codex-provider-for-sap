/**
 * Per-model reasoning effort defaults, shared by the Copilot model picker
 * (configurationSchema defaults) and the request encoding layer.
 *
 * Matched against model-id segments (split on -, _, ., whitespace), so
 * "gpt-5.6-luna" matches the "luna" entry.
 */
export type CodexReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export const CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const MODEL_REASONING_EFFORT_OVERRIDES: ReadonlyArray<{
  readonly match: readonly string[];
  readonly effort: CodexReasoningEffort;
}> = [
  { match: ["luna", "terra"], effort: "max" },
  { match: ["sol"], effort: "high" },
];

export function resolveModelReasoningEffort(
  modelId: string | undefined,
): CodexReasoningEffort | undefined {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return undefined;
  }
  const segments = modelId.toLowerCase().split(/[-_.\s]/);
  for (const entry of MODEL_REASONING_EFFORT_OVERRIDES) {
    if (entry.match.some((m) => segments.includes(m))) {
      return entry.effort;
    }
  }
  return undefined;
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string"
    && (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Resolve the effective effort for a request. Priority:
 * 1. Request-scoped selection from the Copilot model picker (modelOptions)
 * 2. Per-model default table
 * 3. Global `copilotCodex.chatgpt.reasoningEffort` setting
 */
export function resolveEffectiveReasoningEffort(
  requestOptions: unknown,
  modelId: string | undefined,
  globalSetting: unknown,
): CodexReasoningEffort | undefined {
  if (isCodexReasoningEffort(requestOptions)) {
    return requestOptions;
  }
  const perModel = resolveModelReasoningEffort(modelId);
  if (perModel !== undefined) {
    return perModel;
  }
  return isCodexReasoningEffort(globalSetting) ? globalSetting : undefined;
}
