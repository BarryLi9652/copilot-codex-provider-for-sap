import type { CodexModel } from "../../core/types.js";

export const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
export const DEFAULT_AUTO_COMPACT_RATIO = 0.9;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const positiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const resolveEffectivePercent = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    return DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT;
  }

  return value;
};

const resolveAutoCompactLimit = (contextWindow: number, value: unknown): number => {
  const maximum = Math.floor(contextWindow * DEFAULT_AUTO_COMPACT_RATIO);
  const configured = positiveNumber(value);
  return Math.min(configured === undefined ? maximum : Math.floor(configured), maximum);
};

const resolveFamily = (slug: string): string => {
  const separator = slug.indexOf("-");
  return separator > 0 ? slug.slice(0, separator) : slug;
};

const resolveTokenLimits = (entry: JsonRecord): {
  maxInputTokens: number;
  maxOutputTokens: number;
} | undefined => {
  const contextWindow = positiveNumber(entry.context_window) ?? positiveNumber(entry.max_context_window);
  if (contextWindow === undefined) {
    return undefined;
  }

  const maxContextWindow = positiveNumber(entry.max_context_window) ?? contextWindow;
  const effectiveContext = Math.max(
    1,
    Math.floor(contextWindow * resolveEffectivePercent(entry.effective_context_window_percent) / 100),
  );
  const autoCompactLimit = resolveAutoCompactLimit(contextWindow, entry.auto_compact_token_limit);
  const outputBudget = maxContextWindow > contextWindow
    ? maxContextWindow - contextWindow
    : contextWindow - autoCompactLimit;

  return {
    maxInputTokens: effectiveContext,
    maxOutputTokens: Math.max(1, Math.floor(outputBudget)),
  };
};

const toCodexModel = (value: unknown): { model: CodexModel; priority: number } | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.visibility !== "list") {
    return undefined;
  }

  const id = stringValue(value.slug);
  const name = stringValue(value.display_name);
  const tokenLimits = resolveTokenLimits(value);
  if (id === undefined || name === undefined || tokenLimits === undefined) {
    return undefined;
  }

  const modalities = Array.isArray(value.input_modalities)
    ? value.input_modalities.filter((modality): modality is string => typeof modality === "string")
    : [];
  const shellType = stringValue(value.shell_type);
  const toolCalling = shellType !== undefined && shellType !== "disabled";
  const parallelToolCalls = toolCalling && value.supports_parallel_tool_calls === true;
  const version = stringValue(value.comp_hash) ?? id;
  const priority = typeof value.priority === "number" && Number.isFinite(value.priority)
    ? value.priority
    : Number.MAX_SAFE_INTEGER;

  return {
    model: {
      id,
      name,
      family: resolveFamily(id),
      version,
      maxInputTokens: tokenLimits.maxInputTokens,
      maxOutputTokens: tokenLimits.maxOutputTokens,
      capabilities: {
        imageInput: modalities.some((modality) => modality.toLowerCase() === "image"),
        toolCalling,
        parallelToolCalls,
      },
    },
    priority,
  };
};

export function parseChatGptModels(payload: unknown): readonly CodexModel[] {
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.models)
      ? payload.models
      : [];

  return entries
    .map(toCodexModel)
    .filter((entry): entry is { model: CodexModel; priority: number } => entry !== undefined)
    .sort((left, right) => left.priority - right.priority)
    .map((entry) => entry.model);
}
