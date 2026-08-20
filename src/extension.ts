import * as vscode from "vscode";

import { CHATGPT_VENDOR_ID, LOCAL_VENDOR_ID } from "./constants";
import { UnavailableProvider } from "./providers/unavailable-provider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(
      CHATGPT_VENDOR_ID,
      new UnavailableProvider("ChatGPT OAuth Codex provider is not available yet."),
    ),
    vscode.lm.registerLanguageModelChatProvider(
      LOCAL_VENDOR_ID,
      new UnavailableProvider("Local Codex provider is not available yet."),
    ),
  );
}

export function deactivate(): void {}
