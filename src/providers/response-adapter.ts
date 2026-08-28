import * as vscode from "vscode";

import type { TransportEvent } from "../core/types.js";

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
  }
}
