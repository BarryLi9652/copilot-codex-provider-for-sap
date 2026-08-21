import {
  RECOGNIZED_ABAP_TOOL_NAMES,
} from "../constants.js";
import type { SapContext } from "./context.js";

const recognizedToolNames = new Set<string>(RECOGNIZED_ABAP_TOOL_NAMES);

export function buildSapInstructions(
  context: SapContext,
  toolNames: readonly string[],
): string {
  const suppliedRecognizedTools = [...new Set(toolNames.filter((name) => recognizedToolNames.has(name)))];
  const lines = [
    "ABAP/SAP guidance:",
    "- Prefer supplied semantic ABAP tools when they are available.",
    "- Do not recursively enumerate `adt://`.",
    "- Use open document text for unsaved content.",
    "- Request modifying/activating actions only after explicit user intent.",
    "- Copilot owns approval and execution.",
    `- ABAP FS installed: ${context.abapFsInstalled ? "yes" : "no"}; SAP ADT installed: ${context.adtInstalled ? "yes" : "no"}.`,
  ];

  if (suppliedRecognizedTools.length > 0) {
    lines.push(`- Recognized supplied ABAP tools: ${suppliedRecognizedTools.join(", ")}.`);
  }

  if (context.activeDocument !== undefined) {
    const document = context.activeDocument;
    lines.push(`- Active document: ${document.uri} (${document.languageId}; dirty: ${document.dirty ? "yes" : "no"}).`);
    if (document.selection !== undefined) {
      lines.push(`- Selected document text:\n${document.selection}`);
    }
  }

  if (context.diagnostics.length > 0) {
    lines.push("- Active document diagnostics:");
    for (const diagnostic of context.diagnostics) {
      lines.push(`  - ${diagnostic.severity} at ${diagnostic.range}: ${diagnostic.message}`);
    }
  }

  return lines.join("\n");
}
