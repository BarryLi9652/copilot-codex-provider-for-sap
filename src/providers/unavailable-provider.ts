import * as vscode from "vscode";

export class UnavailableProvider implements vscode.LanguageModelChatProvider {
  public constructor(private readonly errorMessage: string) {}

  public provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    return [];
  }

  public async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    _messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    throw new Error(this.errorMessage);
  }

  public provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    const textLength = typeof text === "string"
      ? text.length
      : text.content.reduce<number>((length, part) => {
        if (part instanceof vscode.LanguageModelTextPart) {
          return length + part.value.length;
        }

        return length;
      }, 0);

    return Promise.resolve(Math.ceil(textLength / 4));
  }
}
