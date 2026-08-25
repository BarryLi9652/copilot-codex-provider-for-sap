import * as vscode from "vscode";

import {
  buildDiagnosticsReport,
  DiagnosticsHistory,
  type DiagnosticsRouteSnapshot,
} from "./commands/diagnostics";
import {
  createCommandServices,
  createProxySetupServices,
  createSapProxyBypassServices,
  registerCommands,
  type CommandDependencies,
  type CommandUi,
  type ManagerActionId,
  type ProxySetupChoice,
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
import {
  resolveChatGptRequestOverrides,
  type ChatGptRequestOverrides,
} from "./transports/chatgpt-oauth/request-codec";

export type ChatGptModelCatalogServices = CommandDependencies["chatgptModels"] & {
  restore(): Promise<number>;
};

export const readGlobalNoProxyHosts = (configuration: {
  inspect<T>(section: string): { globalValue?: T } | undefined;
}): readonly string[] => configuration.inspect<readonly string[]>("noProxy")?.globalValue ?? [];

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

export const createLocalModelCatalogServices = (
  provider: CodexLanguageModelProvider,
  session: Pick<AppServerSession, "listModels">,
  providerCache: ModelCache,
  transportCache: ModelCache,
) => ({
  refresh: async (): Promise<number> => {
    providerCache.clear();
    transportCache.clear();
    const models = await session.listModels(true);
    provider.invalidateModelInformation();
    return models.length;
  },
  clear: (): void => {
    providerCache.clear();
    transportCache.clear();
    provider.invalidateModelInformation();
  },
});

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

export interface ChatGptRequestConfiguration {
  get(section: string): unknown;
}

export const createChatGptRequestOverridesResolver = (
  configuration: ChatGptRequestConfiguration,
): (() => ChatGptRequestOverrides) => () => resolveChatGptRequestOverrides(
  configuration.get("chatgpt.reasoningEffort"),
  configuration.get("chatgpt.speedMode"),
);

type ManagerQuickPickItem = vscode.QuickPickItem & {
  readonly action?: ManagerActionId;
};

type ProxySetupQuickPickItem = vscode.QuickPickItem & {
  readonly choice: ProxySetupChoice;
};

const PROXY_ONBOARDING_STATE_KEY = "proxyOnboarding.completed.v1";

const MANAGER_QUICK_PICK_ITEMS: readonly ManagerQuickPickItem[] = [
  { label: "ChatGPT OAuth", kind: vscode.QuickPickItemKind.Separator },
  { label: "$(sign-in) Sign In with ChatGPT", action: "copilotCodex.chatgpt.signIn" },
  { label: "$(link) Complete ChatGPT Sign-In Manually", action: "copilotCodex.chatgpt.signInManual" },
  { label: "$(sign-out) Sign Out ChatGPT", action: "copilotCodex.chatgpt.signOut" },
  { label: "$(refresh) Refresh ChatGPT Models", action: "copilotCodex.chatgpt.refreshModels" },
  { label: "$(globe) Configure ChatGPT Proxy", action: "configureProxy" },
  { label: "$(shield) Configure SAP Proxy Bypass", action: "configureSapProxyBypass" },
  { label: "Local Codex", kind: vscode.QuickPickItemKind.Separator },
  { label: "$(file-binary) Select Local Codex Executable", action: "copilotCodex.local.selectExecutable" },
  { label: "$(play) Start Local Codex", action: "copilotCodex.local.start" },
  { label: "$(debug-restart) Restart Local Codex", action: "copilotCodex.local.restart" },
  { label: "$(debug-stop) Stop Local Codex", action: "copilotCodex.local.stop" },
  { label: "$(refresh) Refresh Local Models", action: "copilotCodex.local.refreshModels" },
  { label: "Extension", kind: vscode.QuickPickItemKind.Separator },
  { label: "$(settings-gear) Open Settings", action: "openSettings" },
  { label: "$(output) Show Diagnostics", action: "copilotCodex.showDiagnostics" },
  { label: "$(trash) Clear Extension Data", action: "copilotCodex.clearExtensionData" },
];

const PROXY_SETUP_QUICK_PICK_ITEMS: readonly ProxySetupQuickPickItem[] = [
  {
    label: "$(globe) Configure ChatGPT-only proxy (Recommended)",
    description: "Clash/Mihomo HTTP or Mixed port",
    detail: "Routes only ChatGPT OAuth, model discovery, and replies; does not change SAP or VS Code system proxy settings.",
    choice: "configure",
  },
  {
    label: "$(server-environment) Use environment proxy",
    description: "HTTP_PROXY / HTTPS_PROXY / NO_PROXY",
    detail: "Leaves the extension proxy empty. Add SAP hosts to NO_PROXY when the inherited proxy would block ABAP FS or ADT.",
    choice: "environment",
  },
  {
    label: "$(clock) Configure later",
    description: "Keep current settings",
    detail: "Run Configure ChatGPT Proxy from Codex Copilot Manager at any time.",
    choice: "skip",
  },
];

export function activate(context: vscode.ExtensionContext): void {
  const configuration = vscode.workspace.getConfiguration("copilotCodex");
  const httpConfiguration = vscode.workspace.getConfiguration("http");
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
    requestOverrides: createChatGptRequestOverridesResolver(configuration),
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
  const localModelCatalog = createLocalModelCatalogServices(
    localProvider,
    localSession,
    localProviderCache,
    localModelCache,
  );
  const proxySetup = createProxySetupServices({
    getProxyUrl: () => configuration.get<string>("chatgpt.proxyUrl", ""),
    setProxyUrl: async (value) => {
      await configuration.update(
        "chatgpt.proxyUrl",
        value,
        vscode.ConfigurationTarget.Global,
      );
    },
    hasCompletedOnboarding: () => context.globalState.get<boolean>(
      PROXY_ONBOARDING_STATE_KEY,
      false,
    ),
    markOnboardingCompleted: async () => {
      await context.globalState.update(PROXY_ONBOARDING_STATE_KEY, true);
    },
  }, {
    choose: async (onboarding) => {
      const selected = await vscode.window.showQuickPick(PROXY_SETUP_QUICK_PICK_ITEMS, {
        title: onboarding ? "Set Up ChatGPT Proxy" : "Configure ChatGPT Proxy",
        placeHolder: "Choose how ChatGPT requests should reach the network",
      });
      return selected?.choice;
    },
    promptProxyUrl: async (defaultValue) => vscode.window.showInputBox({
      title: "ChatGPT-only Proxy URL",
      prompt: "Enter an HTTP(S) proxy URL. Example: Clash/Mihomo HTTP or Mixed port.",
      value: defaultValue,
      ignoreFocusOut: true,
    }),
    showInvalidProxy: async () => {
      await vscode.window.showErrorMessage(
        "Enter a valid HTTP(S) proxy URL, for example http://127.0.0.1:7897.",
      );
    },
    showReloadRequired: async () => {
      const selected = await vscode.window.showInformationMessage(
        "ChatGPT proxy setting saved. Reload VS Code before signing in or refreshing models.",
        "Reload Now",
      );
      if (selected === "Reload Now") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    },
  });
  const sapProxyBypass = createSapProxyBypassServices({
    getNoProxyHosts: () => readGlobalNoProxyHosts(httpConfiguration),
    setNoProxyHosts: async (value) => {
      await httpConfiguration.update(
        "noProxy",
        value,
        vscode.ConfigurationTarget.Global,
      );
    },
  }, {
    promptNoProxyHosts: async (defaultValue) => vscode.window.showInputBox({
      title: "SAP Proxy Bypass Hosts",
      prompt: "Enter SAP hostnames or IP addresses separated by commas or new lines.",
      value: defaultValue,
      ignoreFocusOut: true,
    }),
    showReloadRequired: async () => {
      const selected = await vscode.window.showInformationMessage(
        "SAP hosts were added to VS Code http.noProxy. Reload VS Code to apply the shared proxy bypass.",
        "Reload Now",
      );
      if (selected === "Reload Now") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    },
  });

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
    proxySetup,
    sapProxyBypass,
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
        const modelCount = await localModelCatalog.refresh();
        const account = await localSession.readAccount();
        appServerAccountType = account.type;
        return modelCount;
      },
      clearModels: () => localModelCatalog.clear(),
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
      "Codex Copilot command failed. Open 'Codex Copilot Manager' and select 'Show Diagnostics' for safe details.",
    ),
    selectManagerAction: async () => {
      const selected = await vscode.window.showQuickPick(MANAGER_QUICK_PICK_ITEMS, {
        title: "Codex Copilot Manager",
        placeHolder: "Select an operation",
      });
      return selected?.action;
    },
    openSettings: () => vscode.commands.executeCommand(
      "workbench.action.openSettings",
      `@ext:${context.extension.id}`,
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
