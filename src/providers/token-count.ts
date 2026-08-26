import * as vscode from "vscode";

interface TokenEstimate {
  readonly characters: number;
  readonly imageTokens: number;
}

const emptyEstimate = (): TokenEstimate => ({ characters: 0, imageTokens: 0 });

const addEstimate = (left: TokenEstimate, right: TokenEstimate): TokenEstimate => ({
  characters: left.characters + right.characters,
  imageTokens: left.imageTokens + right.imageTokens,
});

const serializedLength = (value: unknown): number => {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
};

const imageTokens = (bytes: number): number => {
  if (bytes <= 64 * 1024) {
    return 256;
  }
  if (bytes <= 512 * 1024) {
    return 512;
  }
  if (bytes <= 1024 * 1024) {
    return 1_024;
  }
  return 2_048;
};

const estimateDataPart = (part: vscode.LanguageModelDataPart): TokenEstimate =>
  part.mimeType.startsWith("image/")
    ? { characters: 0, imageTokens: imageTokens(part.data.byteLength) }
    : emptyEstimate();

const estimateToolResultContent = (part: unknown): TokenEstimate => {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { characters: part.value.length, imageTokens: 0 };
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return estimateDataPart(part);
  }
  return { characters: serializedLength(part), imageTokens: 0 };
};

const estimateMessagePart = (part: unknown): TokenEstimate => {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { characters: part.value.length, imageTokens: 0 };
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return estimateDataPart(part);
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return {
      characters: serializedLength({ callId: part.callId, name: part.name, input: part.input }),
      imageTokens: 0,
    };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.reduce<TokenEstimate>(
      (estimate, content) => addEstimate(estimate, estimateToolResultContent(content)),
      { characters: serializedLength({ callId: part.callId }), imageTokens: 0 },
    );
  }
  return { characters: serializedLength(part), imageTokens: 0 };
};

const estimateMessage = (message: vscode.LanguageModelChatRequestMessage): TokenEstimate =>
  message.content.reduce<TokenEstimate>(
    (estimate, part) => addEstimate(estimate, estimateMessagePart(part)),
    emptyEstimate(),
  );

export function countTokens(
  text: string | vscode.LanguageModelChatRequestMessage,
): number {
  const estimate = typeof text === "string"
    ? { characters: text.length, imageTokens: 0 }
    : estimateMessage(text);
  return Math.max(1, Math.ceil(estimate.characters / 4) + estimate.imageTokens);
}

export const estimateTokenCount = countTokens;
