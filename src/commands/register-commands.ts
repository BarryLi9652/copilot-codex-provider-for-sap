import * as vscode from "vscode";

export const MANAGER_COMMAND_ID = "copilotCodex.manager" as const;

export const MANAGER_ACTION_IDS = [
  "copilotCodex.chatgpt.signIn",
  "copilotCodex.chatgpt.signInManual",
  "copilotCodex.chatgpt.importLocalSession",
  "copilotCodex.chatgpt.signOut",
  "copilotCodex.chatgpt.refreshModels",
  "copilotCodex.local.selectExecutable",
  "copilotCodex.local.start",
  "copilotCodex.local.restart",
  "copilotCodex.local.stop",
  "copilotCodex.local.refreshModels",
  "copilotCodex.showDiagnostics",
  "copilotCodex.clearExtensionData",
] as const;

export const COMMAND_IDS = [MANAGER_COMMAND_ID, ...MANAGER_ACTION_IDS] as const;

export type CommandId = typeof COMMAND_IDS[number];
export type ManagerActionId = typeof MANAGER_ACTION_IDS[number]
  | "configureProxy"
  | "configureSapProxyBypass"
  | "openSettings";
export type CommandServices = Readonly<Record<CommandId, () => Promise<void>>>;

export const DEFAULT_CHATGPT_PROXY_URL = "http://127.0.0.1:7897";

export type ProxySetupChoice = "configure" | "environment" | "skip";

export interface ProxySetupServices {
  ensureFirstUse(): Promise<void>;
  configure(): Promise<void>;
}

export interface ProxySetupStore {
  getProxyUrl(): string;
  setProxyUrl(value: string): Promise<void>;
  hasCompletedOnboarding(): boolean;
  markOnboardingCompleted(): Promise<void>;
}

export interface ProxySetupUi {
  choose(onboarding: boolean): Promise<ProxySetupChoice | undefined>;
  promptProxyUrl(defaultValue: string): Promise<string | undefined>;
  showInvalidProxy(): Promise<void>;
  showReloadRequired(): Promise<void>;
}

export interface SapProxyBypassServices {
  configure(): Promise<void>;
}

export interface SapProxyBypassStore {
  getNoProxyHosts(): readonly string[];
  setNoProxyHosts(value: readonly string[]): Promise<void>;
}

export interface SapProxyBypassUi {
  promptNoProxyHosts(defaultValue: string): Promise<string | undefined>;
  showReloadRequired(): Promise<void>;
}

export function createSapProxyBypassServices(
  store: SapProxyBypassStore,
  ui: SapProxyBypassUi,
): SapProxyBypassServices {
  return {
    configure: async () => {
      const existing = store.getNoProxyHosts();
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const host of existing) {
        const key = host.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(host);
        }
      }
      const entered = await ui.promptNoProxyHosts(merged.join(", "));
      if (entered === undefined) {
        return;
      }
      for (const host of entered.split(/[,\r\n]+/).map((value) => value.trim()).filter(Boolean)) {
        const key = host.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(host);
        }
      }
      await store.setNoProxyHosts(merged);
      await ui.showReloadRequired();
    },
  };
}

const normalizeHttpProxyUrl = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
};

export function createProxySetupServices(
  store: ProxySetupStore,
  ui: ProxySetupUi,
): ProxySetupServices {
  const run = async (onboarding: boolean): Promise<void> => {
    const choice = await ui.choose(onboarding);
    if (choice === undefined) {
      return;
    }
    if (choice === "skip") {
      await store.markOnboardingCompleted();
      return;
    }
    if (choice === "environment") {
      await store.setProxyUrl("");
      await store.markOnboardingCompleted();
      await ui.showReloadRequired();
      return;
    }

    const entered = await ui.promptProxyUrl(store.getProxyUrl() || DEFAULT_CHATGPT_PROXY_URL);
    if (entered === undefined) {
      return;
    }
    const proxyUrl = normalizeHttpProxyUrl(entered);
    if (proxyUrl === undefined) {
      await ui.showInvalidProxy();
      return;
    }
    await store.setProxyUrl(proxyUrl);
    await store.markOnboardingCompleted();
    await ui.showReloadRequired();
  };

  return {
    ensureFirstUse: async () => {
      if (store.getProxyUrl().trim().length > 0 || store.hasCompletedOnboarding()) {
        return;
      }
      await run(true);
    },
    configure: () => run(false),
  };
}

export interface CommandDependencies {
  readonly proxySetup: ProxySetupServices;
  readonly sapProxyBypass: SapProxyBypassServices;
  readonly oauth: {
    signIn(openExternal: (url: string) => Promise<boolean>): Promise<unknown>;
    completeManualCallback(url: string): Promise<unknown>;
    importLocalSession?(): Promise<void>;
    signOut(): Promise<void>;
    clearSecret(): Promise<void>;
  };
  readonly chatgptModels: {
    refresh(): Promise<number>;
    clear(): void;
  };
  readonly local: {
    selectExecutable(path: string): Promise<void>;
    start(): Promise<void>;
    restart(): Promise<void>;
    stop(): Promise<void>;
    refreshModels(): Promise<number>;
    clearModels(): void;
  };
  readonly continuations: { clear(): void };
  readonly diagnostics: {
    show(): Promise<void>;
    clear(): void;
    record(error: unknown): void;
  };
}

export interface CommandUi {
  confirmPrivateSignIn(): PromiseLike<boolean>;
  openExternal(url: string): PromiseLike<boolean>;
  promptManualCallback(): PromiseLike<string | undefined>;
  selectExecutable(): PromiseLike<string | undefined>;
  showInformation(message: string): PromiseLike<unknown>;
  showSafeError(): PromiseLike<unknown>;
  selectManagerAction(): PromiseLike<ManagerActionId | undefined>;
  openSettings(): PromiseLike<unknown>;
}

export interface CommandRegistrar {
  registerCommand(id: string, handler: () => Promise<void>): vscode.Disposable;
}

const runSafely = async (
  operation: () => Promise<void>,
  dependencies: CommandDependencies,
  ui: CommandUi,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    dependencies.diagnostics.record(error);
    await ui.showSafeError();
  }
};

export function createCommandServices(
  dependencies: CommandDependencies,
  ui: CommandUi,
): CommandServices {
  const safe = (operation: () => Promise<void>): (() => Promise<void>) =>
    () => runSafely(operation, dependencies, ui);
  const actions: Readonly<Record<typeof MANAGER_ACTION_IDS[number], () => Promise<void>>> = {
    "copilotCodex.chatgpt.signIn": safe(async () => {
      if (!await ui.confirmPrivateSignIn()) {
        return;
      }
      await dependencies.oauth.signIn(async (url) => ui.openExternal(url));
      const count = await dependencies.chatgptModels.refresh();
      await ui.showInformation(`ChatGPT sign-in completed (${count} models).`);
    }),
    "copilotCodex.chatgpt.signInManual": safe(async () => {
      const callbackUrl = await ui.promptManualCallback();
      if (callbackUrl === undefined) {
        return;
      }
      await dependencies.oauth.completeManualCallback(callbackUrl);
      const count = await dependencies.chatgptModels.refresh();
      await ui.showInformation(`Manual ChatGPT callback completed (${count} models).`);
    }),
    "copilotCodex.chatgpt.importLocalSession": safe(async () => {
      if (dependencies.oauth.importLocalSession === undefined) {
        throw new Error("Importing the local Codex ChatGPT session is unavailable.");
      }
      await dependencies.oauth.importLocalSession();
      const count = await dependencies.chatgptModels.refresh();
      await ui.showInformation(`Local Codex ChatGPT session imported (${count} models).`);
    }),
    "copilotCodex.chatgpt.signOut": safe(async () => {
      try {
        await dependencies.oauth.signOut();
      } finally {
        dependencies.chatgptModels.clear();
      }
      await ui.showInformation("This extension's ChatGPT session was cleared.");
    }),
    "copilotCodex.chatgpt.refreshModels": safe(async () => {
      const count = await dependencies.chatgptModels.refresh();
      await ui.showInformation(`ChatGPT OAuth model catalog refreshed (${count} models).`);
    }),
    "copilotCodex.local.selectExecutable": safe(async () => {
      const path = await ui.selectExecutable();
      if (path !== undefined) {
        await dependencies.local.selectExecutable(path);
        await ui.showInformation("Codex executable saved. Reload VS Code before starting Local CLI.");
      }
    }),
    "copilotCodex.local.start": safe(async () => {
      await dependencies.local.start();
      await ui.showInformation("Local Codex App Server started.");
    }),
    "copilotCodex.local.restart": safe(async () => {
      await dependencies.local.restart();
      await ui.showInformation("Local Codex App Server restarted.");
    }),
    "copilotCodex.local.stop": safe(async () => {
      await dependencies.local.stop();
      await ui.showInformation("Local Codex App Server stopped.");
    }),
    "copilotCodex.local.refreshModels": safe(async () => {
      const count = await dependencies.local.refreshModels();
      await ui.showInformation(`Local Codex model catalog refreshed (${count} models).`);
    }),
    "copilotCodex.showDiagnostics": safe(() => dependencies.diagnostics.show()),
    "copilotCodex.clearExtensionData": safe(async () => {
      const operations: readonly (() => void | Promise<void>)[] = [
        () => dependencies.oauth.clearSecret(),
        () => dependencies.chatgptModels.clear(),
        () => dependencies.local.clearModels(),
        () => dependencies.continuations.clear(),
        () => dependencies.diagnostics.clear(),
      ];
      const results = await Promise.allSettled(
        operations.map(async (operation) => operation()),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) {
        throw failure.reason;
      }
      await ui.showInformation("Copilot Codex Provider extension data was cleared.");
    }),
  };
  return {
    [MANAGER_COMMAND_ID]: safe(async () => {
      await dependencies.proxySetup.ensureFirstUse();
      const selected = await ui.selectManagerAction();
      if (selected === undefined) {
        return;
      }
      if (selected === "configureProxy") {
        await dependencies.proxySetup.configure();
        return;
      }
      if (selected === "configureSapProxyBypass") {
        await dependencies.sapProxyBypass.configure();
        return;
      }
      if (selected === "openSettings") {
        await ui.openSettings();
        return;
      }
      await actions[selected]();
    }),
    ...actions,
  };
}

export function registerCommands(
  services: CommandServices,
  context: vscode.ExtensionContext,
  registrar: CommandRegistrar = vscode.commands,
): readonly vscode.Disposable[] {
  const registrations = COMMAND_IDS.map((id) => registrar.registerCommand(id, services[id]));
  context.subscriptions.push(...registrations);
  return registrations;
}
