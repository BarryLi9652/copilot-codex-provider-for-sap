import * as vscode from "vscode";

import {
  buildDiagnosticsReport,
  DiagnosticsHistory,
  type DiagnosticsRouteSnapshot,
} from "./commands/diagnostics";
import {
  createCommandServices,
  registerCommands,
  type CommandDependencies,
  type CommandUi,
} from "./commands/register-commands";
import { CHATGPT_VENDOR_ID, LOCAL_VENDOR_ID } from "./constants";
import { ModelCache } from "./core/model-cache";
import type { CodexTransport } from "./core/types";
import { CodexLanguageModelProvider } from "./providers/codex-provider";
import { SapContextProvider } from "./sap/context";
import { SafeLogger, type LogLevel } from "./security/logger";
import { AppServerSession } from "./transports/app-server/app-server-session";
import { AppServerTransport } from "./transports/app-server/app-server-transport";
import { ExecutableLocator } from "./transports/app-server/executable-locator";
import { ProcessSupervisor } from "./transports/app-server/process-supervisor";
import { ToolContinuationRegistry } from "./transports/app-server/tool-continuations";
import { OAuthManager } from "./transports/chatgpt-oauth/oauth-manager";
import { OAuthStore } from "./transports/chatgpt-oauth/oauth-store";
import { ChatGptOAuthTransport } from "./transports/chatgpt-oauth/oauth-transport";
import { createProxyAwareFetch } from "./transports/chatgpt-oauth/proxy-fetch";

export type ChatGptModelCatalogServices = CommandDependencies["chatgptModels"] & {
  restore(): Promise<number>;
};

export const createChatGptModelCatalogServices = (
  provider: CodexLanguageModelProvider,
  transport: Pick<CodexTransport, "listModels">,
  transportCache: ModelCache,
): ChatGptModelCatalogServices => {
  const load = async (options: { silent: boolean; forceRefresh?: boolean }): Promise<number> => {
    const models = await transport.listModels(options, new AbortController().signal);
    provider.invalidateModelInformation();
    return models.length;
  };
  return {
    refresh: () => load({ silent: false, forceRefresh: true }),
    restore: () => load({ silent: true }),
    clear: () => {
      transportCache.clear();
      provider.invalidateModelInformation();
    },
  };
};

export const restorePersistedChatGptModelCatalog = async (options: {
  loadSession(): Promise<unknown | undefined>;
  restore(): Promise<unknown>;
  recordFailure(error: unknown): void;
}): Promise<void> => {
  try {
    if (await options.loadSession() !== undefined) {
      await options.restore();
    }
  } catch (error) {
    options.recordFailure(error);
  }
};

export function activate(context: vscode.ExtensionContext): void {
  const configuration = vscode.workspace.getConfiguration("copilotCodex");
  const requestTimeoutMs = secondsToMs(configuration.get("requestTimeoutSeconds", 600), 10);
  const toolTimeoutMs = secondsToMs(configuration.get("toolTimeoutSeconds", 300), 30);
  const catalogCacheMs = minutesToMs(configuration.get("catalogCacheMinutes", 5), 1);
  const configuredExecutable = configuration.get<string>("local.codexPath", "").trim();
  const configuredChatGptProxy = configuration.get<string>("chatgpt.proxyUrl", "").trim();
  const diagnosticsOutput = vscode.window.createOutputChannel("Copilot Codex Diagnostics");
  const logOutput = vscode.window.createOutputChannel("Copilot Codex Log");
  const logger = new SafeLogger(
    logOutput,
    () => configuration.get<LogLevel>("logLevel", "info"),
  );
  const diagnostics = new DiagnosticsHistory();
  const sapContextProvider = new SapContextProvider();
  const oauthStore = new OAuthStore(context.secrets);
  const chatGptFetch = createProxyAwareFetch(
    process.env,
    configuredChatGptProxy || undefined,
  );
  const oauthManager = new OAuthManager(oauthStore, { fetch: chatGptFetch });
  const chatGptProviderCache = new ModelCache(catalogCacheMs);
  const localProviderCache = new ModelCache(catalogCacheMs);
  const chatGptModelCache = new ModelCache(catalogCacheMs);
  const localModelCache = new ModelCache(catalogCacheMs);
  const chatGptTransport = new ChatGptOAuthTransport(oauthManager, {
    fetch: chatGptFetch,
    timeoutMs: requestTimeoutMs,
    modelCache: chatGptModelCache,
    logger,
  });
  const chatGptProvider = new CodexLanguageModelProvider(
    chatGptTransport,
    CHATGPT_VENDOR_ID,
    { sapContextProvider, modelCache: chatGptProviderCache },
  );
  const chatGptModelCatalog = createChatGptModelCatalogServices(
    chatGptProvider,
    chatGptTransport,
    chatGptModelCache,
  );
  const localExecutable = new ExecutableLocator({
    configuredExecutable: configuredExecutable || undefined,
  });
  const localSupervisor = new ProcessSupervisor({
    locator: localExecutable,
    cwd: context.extensionPath,
    requestTimeoutMs,
    logger,
  });
  const localSession = new AppServerSession(localSupervisor, {
    extensionVersion: String(context.extension.packageJSON.version ?? "0.1.0"),
    modelCacheTtlMs: catalogCacheMs,
    modelCache: localModelCache,
    logger,
  });
  const continuationRegistry = new ToolContinuationRegistry({ timeoutMs: toolTimeoutMs });
  const localTransport = new AppServerTransport(
    localSession,
    continuationRegistry,
    { failedCallTtlMs: toolTimeoutMs, logger },
  );
  const localProvider = new CodexLanguageModelProvider(
    localTransport,
    LOCAL_VENDOR_ID,
    { sapContextProvider, modelCache: localProviderCache },
  );

  let appServerAccountType: "chatgpt" | "personalAccessToken" | undefined;
  const cacheSnapshot = (
    providerCache: ModelCache,
    transportCache: ModelCache,
    available: boolean,
  ): DiagnosticsRouteSnapshot => ({
    available,
    ...(providerCache.snapshot() ?? transportCache.snapshot()),
  });

  const dependencies: CommandDependencies = {
    oauth: {
      signIn: (openExternal) => oauthManager.signIn(openExternal),
      completeManualCallback: (url) => oauthManager.completeManualCallback(url),
      signOut: () => oauthManager.signOut(),
      clearSecret: () => oauthManager.signOut(),
    },
    chatgptModels: chatGptModelCatalog,
    local: {
      selectExecutable: async (path) => {
        new ExecutableLocator({ configuredExecutable: path }).resolve();
        await configuration.update("local.codexPath", path, vscode.ConfigurationTarget.Global);
      },
      start: async () => {
        await localSession.initialize();
        const account = await localSession.readAccount();
        appServerAccountType = account.type;
      },
      restart: async () => {
        await localSession.restart();
        const account = await localSession.readAccount();
        appServerAccountType = account.type;
      },
      stop: async () => {
        await localSupervisor.stop();
        appServerAccountType = undefined;
      },
      refreshModels: async () => {
        localProviderCache.clear();
        localModelCache.clear();
        await localSession.initialize();
        const models = await localSession.listModels();
        const account = await localSession.readAccount();
        appServerAccountType = account.type;
        return models.length;
      },
      clearModels: () => {
        localProviderCache.clear();
        localModelCache.clear();
      },
    },
    continuations: { clear: () => continuationRegistry.dispose() },
    diagnostics: {
      show: async () => {
        const session = await oauthStore.load();
        let executablePath: string | undefined;
        try {
          executablePath = localExecutable.resolve();
        } catch {
          executablePath = undefined;
        }
        if (localSupervisor.state === "running" && appServerAccountType === undefined) {
          try {
            appServerAccountType = (await localSession.readAccount()).type;
          } catch (error) {
            diagnostics.record(error);
          }
        }
        const sap = sapContextProvider.collect();
        diagnosticsOutput.clear();
        diagnosticsOutput.appendLine(buildDiagnosticsReport({
          extensionVersion: String(context.extension.packageJSON.version ?? "unknown"),
          vscodeVersion: vscode.version,
          platform: `${process.platform}-${process.arch}`,
          chatgpt: cacheSnapshot(
            chatGptProviderCache,
            chatGptModelCache,
            session !== undefined,
          ),
          local: cacheSnapshot(
            localProviderCache,
            localModelCache,
            executablePath !== undefined,
          ),
          executablePath,
          appServer: {
            processState: localSupervisor.state,
            ...localSession.currentCapabilities,
            accountType: appServerAccountType,
          },
          sap: {
            abapFsInstalled: sap.abapFsInstalled,
            adtInstalled: sap.adtInstalled,
          },
          lastErrorCodes: diagnostics.snapshot(),
        }));
        diagnosticsOutput.show(true);
      },
      clear: () => {
        diagnostics.clear();
        diagnosticsOutput.clear();
        logOutput.clear();
      },
      record: (error) => diagnostics.record(error),
    },
  };
  const ui: CommandUi = {
    confirmPrivateSignIn: async () => {
      const signedIn = await oauthStore.load() !== undefined;
      const choice = await vscode.window.showWarningMessage(
        `ChatGPT OAuth status: ${signedIn ? "signed in" : "signed out"}. This route uses a private ChatGPT Codex interface that may change without notice.`,
        { modal: true },
        "Continue",
      );
      return choice === "Continue";
    },
    openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    promptManualCallback: () => vscode.window.showInputBox({
      title: "Complete ChatGPT Sign-In Manually",
      prompt: "Paste the complete callback URL without editing it.",
      ignoreFocusOut: true,
    }),
    selectExecutable: async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Select Codex executable",
      });
      return selected?.[0]?.fsPath;
    },
    showInformation: (message) => vscode.window.showInformationMessage(message),
    showSafeError: () => vscode.window.showErrorMessage(
      "Copilot Codex command failed. Run 'Copilot Codex: Show Diagnostics' for safe details.",
    ),
  };
  registerCommands(createCommandServices(dependencies, ui), context);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(
      CHATGPT_VENDOR_ID,
      chatGptProvider,
    ),
    vscode.lm.registerLanguageModelChatProvider(
      LOCAL_VENDOR_ID,
      localProvider,
    ),
    diagnosticsOutput,
    logOutput,
    chatGptTransport,
    localTransport,
  );
  void restorePersistedChatGptModelCatalog({
    loadSession: () => oauthStore.load(),
    restore: () => chatGptModelCatalog.restore(),
    recordFailure: (error) => diagnostics.record(error),
  });
}

const secondsToMs = (value: number, minimum: number): number =>
  Math.max(minimum, Number.isFinite(value) ? value : minimum) * 1_000;

const minutesToMs = (value: number, minimum: number): number =>
  Math.max(minimum, Number.isFinite(value) ? value : minimum) * 60_000;

export function deactivate(): void {}
