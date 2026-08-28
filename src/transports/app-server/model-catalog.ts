import type { CodexModel } from "../../core/types.js";
import { protocolError } from "./protocol.js";

type JsonRecord = Record<string, unknown>;

const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * When app-server does not report token limits (current codex app-server
 * `model/list` responses omit them), the 128k/16k fallback understates the
 * real GPT-5.x context window and makes Copilot compact history too early.
 * Raise the fallback so context management matches real model capability.
 */
const MISSING_LIMITS_MAX_INPUT_TOKENS = 400_000;
const MISSING_LIMITS_MAX_OUTPUT_TOKENS = 64_000;

export interface AppServerCodexModel extends CodexModel {
  description?: string;
}

export interface AppServerModelDiagnostics {
  missingFields: readonly string[];
}

export interface AppServerModelCatalogOptions {
  dynamicToolsAvailable: boolean;
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const hasOwn = (value: JsonRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const resolveFamily = (id: string): string => {
  const separator = id.indexOf("-");
  return separator > 0 ? id.slice(0, separator) : id;
};

const resolveNumber = (
  entry: JsonRecord,
  names: readonly string[],
  fallback: number,
): number | undefined => {
  for (const name of names) {
    const value = positiveInteger(entry[name]);
    if (value !== undefined) {
      return value;
    }
  }
  return names.some((name) => hasOwn(entry, name)) ? undefined : fallback;
};

const resolveBoolean = (
  entry: JsonRecord,
  names: readonly string[],
  fallback: boolean,
): boolean => {
  for (const name of names) {
    if (typeof entry[name] === "boolean") {
      return entry[name];
    }
  }
  return names.some((name) => hasOwn(entry, name)) ? false : fallback;
};

const resolveModalities = (entry: JsonRecord): readonly string[] => {
  const value = Array.isArray(entry.inputModalities)
    ? entry.inputModalities
    : Array.isArray(entry.input_modalities)
      ? entry.input_modalities
      : hasOwn(entry, "inputModalities") || hasOwn(entry, "input_modalities")
        ? []
        : ["text", "image"];
  return value.filter((modality): modality is string => typeof modality === "string");
};

const toModel = (
  value: unknown,
  options: AppServerModelCatalogOptions,
  onDiagnostic: ((diagnostic: AppServerModelDiagnostics) => void) | undefined,
): AppServerCodexModel | undefined => {
  if (!isRecord(value)) {
    onDiagnostic?.({ missingFields: ["model"] });
    return undefined;
  }
  if (value.hidden === true || value.visibility === "hidden") {
    return undefined;
  }

  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.displayName) ?? nonEmptyString(value.display_name);
  const reportsTokenLimits =
    ["inputTokenLimit", "input_token_limit", "maxInputTokens"].some((n) => hasOwn(value, n))
    || ["outputTokenLimit", "output_token_limit", "maxOutputTokens"].some((n) => hasOwn(value, n));
  const fallbackInput = reportsTokenLimits ? DEFAULT_MAX_INPUT_TOKENS : MISSING_LIMITS_MAX_INPUT_TOKENS;
  const fallbackOutput = reportsTokenLimits ? DEFAULT_MAX_OUTPUT_TOKENS : MISSING_LIMITS_MAX_OUTPUT_TOKENS;
  const inputTokens = resolveNumber(
    value,
    ["inputTokenLimit", "input_token_limit", "maxInputTokens"],
    fallbackInput,
  );
  const outputTokens = resolveNumber(
    value,
    ["outputTokenLimit", "output_token_limit", "maxOutputTokens"],
    fallbackOutput,
  );
  const missingFields: string[] = [];
  if (id === undefined) {
    missingFields.push("id");
  }
  if (name === undefined) {
    missingFields.push("displayName");
  }
  if (inputTokens === undefined) {
    missingFields.push("inputTokenLimit");
  }
  if (outputTokens === undefined) {
    missingFields.push("outputTokenLimit");
  }
  if (missingFields.length > 0) {
    onDiagnostic?.({ missingFields });
    return undefined;
  }
  if (id === undefined || name === undefined || inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const version = nonEmptyString(value.version)
    ?? nonEmptyString(value.modelVersion)
    ?? id;
  const family = nonEmptyString(value.family) ?? resolveFamily(id);
  const modalities = resolveModalities(value);
  const toolCalling = resolveBoolean(
    value,
    ["supportsTools", "supportsToolCalling", "toolCalling"],
    options.dynamicToolsAvailable,
  );
  const parallelToolCalls = resolveBoolean(
    value,
    ["supportsParallelToolCalls", "parallelToolCalls"],
    false,
  );
  const description = nonEmptyString(value.description);

  const model: AppServerCodexModel = {
    id,
    name,
    family,
    version,
    maxInputTokens: inputTokens,
    maxOutputTokens: outputTokens,
    capabilities: {
      imageInput: modalities.some((modality) => modality.toLowerCase() === "image"),
      toolCalling,
      parallelToolCalls: toolCalling && parallelToolCalls,
    },
  };
  if (description !== undefined) {
    model.description = description;
  }
  return model;
};

export function parseAppServerModels(
  payload: unknown,
  options: AppServerModelCatalogOptions = { dynamicToolsAvailable: false },
  onDiagnostic?: (diagnostic: AppServerModelDiagnostics) => void,
): readonly AppServerCodexModel[] {
  if (!isRecord(payload)) {
    throw protocolError("listModels", new Error("model/list result is not an object"));
  }
  const entries = Array.isArray(payload.models)
    ? payload.models
    : Array.isArray(payload.data)
      ? payload.data
      : undefined;
  if (entries === undefined) {
    throw protocolError("listModels", new Error("model/list result has no model array"));
  }

  return entries
    .map((entry) => toModel(entry, options, onDiagnostic))
    .filter((model): model is AppServerCodexModel => model !== undefined);
}
