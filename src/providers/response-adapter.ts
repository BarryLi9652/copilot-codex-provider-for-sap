import * as vscode from "vscode";

import type { TransportEvent } from "../core/types.js";
import {
  buildUsagePayload,
  COPILOT_USAGE_DATA_PART_MIME_TYPE,
  encodeUsagePayloadJson,
} from "../core/usage-report.js";

export { COPILOT_USAGE_DATA_PART_MIME_TYPE };

const encoder = new TextEncoder();

export function buildUsageDataPart(
  inputTokens: number,
  cachedTokens: number,
  outputTokens: number,
): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(
    encoder.encode(encodeUsagePayloadJson(buildUsagePayload(inputTokens, cachedTokens, outputTokens))),
    COPILOT_USAGE_DATA_PART_MIME_TYPE,
  );
}

export function reportTransportEvent(
  event: TransportEvent,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
  if (event.type === "text-delta") {
    progress.report(new vscode.LanguageModelTextPart(event.text));
    return;
  }

  if (event.type === "tool-call") {
    progress.report(new vscode.LanguageModelToolCallPart(
      event.callId,
      event.name,
      event.input as object,
    ));
    return;
  }

  if (event.type === "usage") {
    progress.report(buildUsageDataPart(
      event.inputTokens ?? 0,
      event.cachedTokens ?? 0,
      event.outputTokens ?? 0,
    ));
  }
}
