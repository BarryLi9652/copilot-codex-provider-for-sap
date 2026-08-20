import * as vscode from "vscode";

import { CHATGPT_VENDOR_ID, LOCAL_VENDOR_ID } from "./constants";
import { CodexLanguageModelProvider } from "./providers/codex-provider";
import { AppServerSession } from "./transports/app-server/app-server-session";
import { AppServerTransport } from "./transports/app-server/app-server-transport";
import { ExecutableLocator } from "./transports/app-server/executable-locator";
import { ProcessSupervisor } from "./transports/app-server/process-supervisor";
import { ToolContinuationRegistry } from "./transports/app-server/tool-continuations";
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
  const localExecutable = new ExecutableLocator();
  const localSupervisor = new ProcessSupervisor({
    locator: localExecutable,
    cwd: context.extensionPath,
  });
  const localSession = new AppServerSession(localSupervisor, {
    extensionVersion: String(context.extension.packageJSON.version ?? "0.1.0"),
  });
  const localTransport = new AppServerTransport(
    localSession,
    new ToolContinuationRegistry(),
  );
  const localProvider = new CodexLanguageModelProvider(
    localTransport,
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
    localTransport,
  );
}

export function deactivate(): void {}
