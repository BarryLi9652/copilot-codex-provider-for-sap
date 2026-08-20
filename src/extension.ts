import * as vscode from "vscode";

import { CHATGPT_VENDOR_ID, LOCAL_VENDOR_ID } from "./constants";
import { CodexError } from "./core/errors";
import { EmptyTransport } from "./core/empty-transport";
import { CodexLanguageModelProvider } from "./providers/codex-provider";

export function activate(context: vscode.ExtensionContext): void {
  const chatGptProvider = new CodexLanguageModelProvider(
    new EmptyTransport(new CodexError("authRequired", { action: "signIn" })),
    CHATGPT_VENDOR_ID,
  );
  const localProvider = new CodexLanguageModelProvider(
    new EmptyTransport(new CodexError("incompatible", { action: "selectCodex" })),
    LOCAL_VENDOR_ID,
  );

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(
      CHATGPT_VENDOR_ID,
      chatGptProvider,
    ),
    vscode.lm.registerLanguageModelChatProvider(
      LOCAL_VENDOR_ID,
      localProvider,
    ),
  );
}

export function deactivate(): void {}
