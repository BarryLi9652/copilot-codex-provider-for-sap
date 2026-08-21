import { CodexError } from "../../core/errors.js";
import type { CodexMessage, MessagePart } from "../../core/types.js";
import type { AppServerUserInput } from "./protocol.js";

export type UserInput = AppServerUserInput;

export interface TranscriptOptions {
  supportsImages?: boolean;
  instructions?: string;
}

const escapeTranscriptText = (value: string): string => value
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e")
  .replace(/\[/g, "\\u005b")
  .replace(/\]/g, "\\u005d");

const escapeJsonText = (value: string): string => {
  let inString = false;
  let escaped = false;
  let output = "";
  for (const character of value) {
    if (!inString) {
      output += character;
      if (character === '"') {
        inString = true;
      }
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (character === "<") {
      output += "\\u003c";
    } else if (character === ">") {
      output += "\\u003e";
    } else if (character === "[") {
      output += "\\u005b";
    } else if (character === "]") {
      output += "\\u005d";
    } else {
      output += character;
    }
  }
  return output;
};

const escapeAttribute = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const jsonText = (value: unknown): string => {
  try {
    return escapeJsonText(JSON.stringify(value) ?? "null");
  } catch (cause) {
    throw new CodexError("protocol", { action: "serializeTranscript", cause });
  }
};

interface RenderState {
  readonly imageInputs: UserInput[];
  imageNumber: number;
}

const imageMarker = (part: Extract<MessagePart, { kind: "image" }>, state: RenderState): string => {
  state.imageNumber += 1;
  state.imageInputs.push({
    type: "image",
    url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`,
  });
  return ` [image-${state.imageNumber}]`;
};

const renderPart = (
  part: MessagePart,
  state: RenderState,
): string => {
  if (part.kind === "text") {
    return escapeTranscriptText(part.text);
  }

  if (part.kind === "image") {
    return imageMarker(part, state);
  }

  if (part.kind === "tool-call") {
    return `<tool-call id="${escapeAttribute(part.callId)}" name="${escapeAttribute(part.name)}">${jsonText(part.input)}</tool-call>`;
  }

  const content = part.content.map((contentPart) => {
    if (contentPart.kind === "text") {
      return escapeTranscriptText(contentPart.text);
    }
    return imageMarker(contentPart, state);
  }).join("");
  return `<tool-result id="${escapeAttribute(part.callId)}">${content}</tool-result>`;
};

const renderMessage = (
  message: CodexMessage,
  state: RenderState,
): string => `<message role="${message.role}">${message.parts.map((part) => renderPart(part, state)).join("")}</message>`;

export function serializeTranscript(
  messages: readonly CodexMessage[],
  options: TranscriptOptions = {},
): UserInput[] {
  const supportsImages = options.supportsImages ?? true;
  const imageInputs: UserInput[] = [];
  const state: RenderState = { imageInputs, imageNumber: 0 };

  if (!supportsImages && messages.some((message) => message.parts.some((part) => (
    part.kind === "image"
    || part.kind === "tool-result" && part.content.some((contentPart) => contentPart.kind === "image")
  )))) {
    throw new CodexError("incompatible", { action: "imageInput" });
  }

  const history = messages.slice(0, -1);
  const current = messages[messages.length - 1];
  const currentContent = current === undefined
    ? ""
    : current.parts.map((part) => renderPart(part, state)).join("");
  const lines = [
    "<copilot-history>",
    ...history.map((message) => renderMessage(message, state)),
    "</copilot-history>",
    `<current-user-message>${currentContent}</current-user-message>`,
  ];

  const instructions = options.instructions;
  const instructionInput = instructions === undefined || instructions.trim().length === 0
    ? []
    : [{ type: "text" as const, text: `<codex-instructions>\n${instructions}\n</codex-instructions>` }];

  return [
    ...instructionInput,
    { type: "text", text: lines.join("\n") },
    ...imageInputs,
  ];
}
