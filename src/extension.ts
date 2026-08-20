import * as vscode from "vscode";

import { CHATGPT_VENDOR_ID, LOCAL_VENDOR_ID } from "./constants";
import { CodexError } from "./core/errors";
import { EmptyTransport } from "./core/empty-transport";
import { CodexLanguageModelProvider } from "./providers/codex-provider";
import { OAuthManager } from "./transports/chatgpt-oauth/oauth-manager";
import { OAuthStore } from "./transports/chatgpt-oauth/oauth-store";
import { ChatGptOAuthTransport } from "./transports/chatgpt-oauth/oauth-transport";

export function activate(context: vscode.ExtensionContext): void {
  const oauthStore = new OAuthStore(context.secrets);
  const oauthManager = new OAuthManager(oauthStore);
  const chatGptProvider = new CodexLanguageModelProvider(
    new ChatGptOAuthTransport(oauthManager),
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
