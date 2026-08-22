import type { CodexRequest } from "../../core/types.js";

const REQUIRED_TOOL_INSTRUCTIONS = [
  "This turn requires at least one supplied dynamic tool call.",
  "Do not return a final answer before invoking an applicable supplied tool.",
  "Only use tools that were supplied for this turn.",
].join("\n");

export function buildAppServerTurnInstructions(
  baseInstructions: string,
  toolMode: CodexRequest["toolMode"],
): string {
  return toolMode === "required"
    ? `${baseInstructions}\n${REQUIRED_TOOL_INSTRUCTIONS}`
    : baseInstructions;
}
