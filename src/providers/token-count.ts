import * as vscode from "vscode";

const serializedToolMetadata = (
  part: vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart,
): string => {
  const metadata = part instanceof vscode.LanguageModelToolCallPart
    ? { callId: part.callId, name: part.name, input: part.input }
    : { callId: part.callId, content: part.content };
  return JSON.stringify(metadata) ?? "";
};

const countMessageCharacters = (message: vscode.LanguageModelChatRequestMessage): number =>
  message.content.reduce<number>((count, part) => {
    if (part instanceof vscode.LanguageModelTextPart) {
      return count + part.value.length;
    }

    if (
      part instanceof vscode.LanguageModelToolCallPart ||
      part instanceof vscode.LanguageModelToolResultPart
    ) {
      return count + serializedToolMetadata(part).length;
    }

    return count;
  }, 0);

export function countTokens(
  text: string | vscode.LanguageModelChatRequestMessage,
): number {
  const characters = typeof text === "string" ? text.length : countMessageCharacters(text);
  return Math.max(1, Math.ceil(characters / 4));
}

export const estimateTokenCount = countTokens;
