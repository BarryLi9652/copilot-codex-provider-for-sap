import assert from "node:assert/strict";

import * as vscode from "vscode";
import * as commandModule from "../../../src/commands/register-commands.js";
import * as extensionModule from "../../../src/extension.js";

import {
  COMMAND_IDS,
  createCommandServices,
  createSapProxyBypassServices,
  registerCommands,
  type CommandDependencies,
  type CommandServices,
  type CommandUi,
  type ManagerActionId,
} from "../../../src/commands/register-commands.js";
import {
  buildDiagnosticsReport,
  DiagnosticsHistory,
} from "../../../src/commands/diagnostics.js";
import { CodexError } from "../../../src/core/errors.js";
import { ModelCache } from "../../../src/core/model-cache.js";
import type { CodexModel, CodexRequest, CodexTransport, TransportEvent } from "../../../src/core/types.js";
import {
  createChatGptModelCatalogServices,
  createChatGptRequestOverridesResolver,
  createLocalModelCatalogServices,
  restorePersistedChatGptModelCatalog,
} from "../../../src/extension.js";
import { CodexLanguageModelProvider } from "../../../src/providers/codex-provider.js";

const expectedCommands = [
  "copilotCodex.manager",
  "copilotCodex.chatgpt.signIn",
  "copilotCodex.chatgpt.signInManual",
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

async function registersExactCommandsAndRoutesIndependently(): Promise<void> {
  const calls: string[] = [];
  const handlers = new Map<string, () => Promise<void>>();
  const services = Object.fromEntries(expectedCommands.map((id) => [
    id,
    async () => { calls.push(id); },
  ])) as unknown as CommandServices;
  const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

  const disposables = registerCommands(services, context, {
    registerCommand: (id, handler) => {
      handlers.set(id, handler);
      return new vscode.Disposable(() => handlers.delete(id));
    },
  });
  try {
    assert.deepEqual([...handlers.keys()], expectedCommands);
    assert.deepEqual(COMMAND_IDS, expectedCommands);
    for (const id of expectedCommands) {
      await handlers.get(id)?.();
    }
    assert.deepEqual(calls, expectedCommands);
  } finally {
    for (const disposable of disposables) {
      disposable.dispose();
    }
  }
  assert.equal(handlers.size, 0);
}

async function managementServicesPreserveRouteAndClearBoundaries(): Promise<void> {
  const calls: string[] = [];
  let managerSelection: ManagerActionId | undefined;
  let manualCallback: string | undefined;
  let openedAuthorizationUrl: string | undefined;
  const dependencies: CommandDependencies = {
    proxySetup: {
      ensureFirstUse: async () => undefined,
      configure: async () => undefined,
    },
    sapProxyBypass: { configure: async () => undefined },
    oauth: {
      signIn: async (openExternal) => {
        await openExternal("https://auth.example/authorize");
        calls.push("oauth.signIn");
      },
      completeManualCallback: async (url) => {
        manualCallback = url;
        calls.push("oauth.manual");
      },
      signOut: async () => { calls.push("oauth.signOut"); },
      clearSecret: async () => { calls.push("oauth.clearSecret"); },
    },
    chatgptModels: {
      refresh: async () => { calls.push("chatgpt.refresh"); return 2; },
      clear: () => { calls.push("chatgpt.clear"); },
    },
    local: {
      selectExecutable: async (path) => { calls.push(`local.select:${path}`); },
      start: async () => { calls.push("local.start"); },
      restart: async () => { calls.push("local.restart"); },
      stop: async () => { calls.push("local.stop"); },
      refreshModels: async () => { calls.push("local.refresh"); return 3; },
      clearModels: () => { calls.push("local.clearModels"); },
    },
    continuations: { clear: () => { calls.push("continuations.clear"); } },
    diagnostics: {
      show: async () => { calls.push("diagnostics.show"); },
      clear: () => { calls.push("diagnostics.clear"); },
      record: () => undefined,
    },
  };
  const completeCallback = "http://127.0.0.1:1455/auth/callback?code=a%2Bb&state=exact#fragment";
  const ui: CommandUi = {
    confirmPrivateSignIn: async () => true,
    openExternal: async (url) => { openedAuthorizationUrl = url; return true; },
    promptManualCallback: async () => completeCallback,
    selectExecutable: async () => "C:\\Tools\\codex.exe",
    showInformation: async () => undefined,
    showSafeError: async () => undefined,
    selectManagerAction: async () => managerSelection,
    openSettings: async () => { calls.push("ui.openSettings"); },
  };
  const services = createCommandServices(dependencies, ui);

  await services["copilotCodex.chatgpt.signIn"]();
  await services["copilotCodex.chatgpt.signInManual"]();
  await services["copilotCodex.local.selectExecutable"]();
  assert.equal(openedAuthorizationUrl, "https://auth.example/authorize");
  assert.equal(manualCallback, completeCallback);
  assert.deepEqual(calls, [
    "oauth.signIn",
    "chatgpt.refresh",
    "oauth.manual",
    "chatgpt.refresh",
    "local.select:C:\\Tools\\codex.exe",
  ]);

  const manager = services as CommandServices & Record<"copilotCodex.manager", () => Promise<void>>;
  calls.length = 0;
  managerSelection = "copilotCodex.local.restart";
  await manager["copilotCodex.manager"]();
  assert.deepEqual(calls, ["local.restart"]);

  calls.length = 0;
  managerSelection = "openSettings";
  await manager["copilotCodex.manager"]();
  assert.deepEqual(calls, ["ui.openSettings"]);

  calls.length = 0;
  managerSelection = undefined;
  await manager["copilotCodex.manager"]();
  assert.equal(calls.length, 0);

  calls.length = 0;
  await services["copilotCodex.clearExtensionData"]();
  assert.deepEqual(calls, [
    "oauth.clearSecret",
    "chatgpt.clear",
    "local.clearModels",
    "continuations.clear",
    "diagnostics.clear",
  ]);
  assert.doesNotMatch(calls.join("\n"), /signOut|local\.stop|logout|config/i);

  calls.length = 0;
  let recordedFailure: unknown;
  let safeErrorCount = 0;
  const failingServices = createCommandServices({
    ...dependencies,
    oauth: {
      ...dependencies.oauth,
      clearSecret: async () => {
        calls.push("oauth.clearSecret.failed");
        throw { code: "network" };
      },
    },
    diagnostics: {
      ...dependencies.diagnostics,
      record: (error) => { recordedFailure = error; },
    },
  }, {
    ...ui,
    showSafeError: async () => { safeErrorCount += 1; },
  });
  await failingServices["copilotCodex.clearExtensionData"]();
  assert.deepEqual(calls, [
    "oauth.clearSecret.failed",
    "chatgpt.clear",
    "local.clearModels",
    "continuations.clear",
    "diagnostics.clear",
  ]);
  assert.deepEqual(recordedFailure, { code: "network" });
  assert.equal(safeErrorCount, 1);

  calls.length = 0;
  const failingSignOut = createCommandServices({
    ...dependencies,
    oauth: {
      ...dependencies.oauth,
      signOut: async () => {
        calls.push("oauth.signOut.failed");
        throw { code: "network" };
      },
    },
  }, ui);
  await failingSignOut["copilotCodex.chatgpt.signOut"]();
  assert.deepEqual(calls, ["oauth.signOut.failed", "chatgpt.clear"]);
}

async function managerRunsFirstUseProxySetupAndAllowsManualReconfiguration(): Promise<void> {
  const calls: string[] = [];
  const dependencies = {
    proxySetup: {
      ensureFirstUse: async () => { calls.push("proxy.ensure"); },
      configure: async () => { calls.push("proxy.configure"); },
    },
    sapProxyBypass: { configure: async () => undefined },
    oauth: {
      signIn: async () => undefined,
      completeManualCallback: async () => undefined,
      signOut: async () => undefined,
      clearSecret: async () => undefined,
    },
    chatgptModels: { refresh: async () => 0, clear: () => undefined },
    local: {
      selectExecutable: async () => undefined,
      start: async () => undefined,
      restart: async () => undefined,
      stop: async () => undefined,
      refreshModels: async () => 0,
      clearModels: () => undefined,
    },
    continuations: { clear: () => undefined },
    diagnostics: {
      show: async () => undefined,
      clear: () => undefined,
      record: () => { calls.push("diagnostics.record"); },
    },
  } satisfies CommandDependencies;
  const ui = {
    confirmPrivateSignIn: async () => true,
    openExternal: async () => true,
    promptManualCallback: async () => undefined,
    selectExecutable: async () => undefined,
    showInformation: async () => undefined,
    showSafeError: async () => { calls.push("ui.error"); },
    selectManagerAction: async () => "configureProxy" as ManagerActionId,
    openSettings: async () => undefined,
  } satisfies CommandUi;

  await createCommandServices(dependencies, ui)["copilotCodex.manager"]();

  assert.deepEqual(calls, ["proxy.ensure", "proxy.configure"]);
}

async function proxyOnboardingPersistsOnlyExplicitSafeChoices(): Promise<void> {
  type ProxySetupServices = {
    ensureFirstUse(): Promise<void>;
    configure(): Promise<void>;
  };
  type CreateProxySetupServices = (
    store: {
      getProxyUrl(): string;
      setProxyUrl(value: string): Promise<void>;
      hasCompletedOnboarding(): boolean;
      markOnboardingCompleted(): Promise<void>;
    },
    ui: {
      choose(onboarding: boolean): Promise<"configure" | "environment" | "skip" | undefined>;
      promptProxyUrl(defaultValue: string): Promise<string | undefined>;
      showInvalidProxy(): Promise<void>;
      showReloadRequired(): Promise<void>;
    },
  ) => ProxySetupServices;
  const createProxySetupServices = (
    commandModule as unknown as { createProxySetupServices?: CreateProxySetupServices }
  ).createProxySetupServices;
  if (createProxySetupServices === undefined) {
    assert.fail("createProxySetupServices is not implemented");
  }

  let proxyUrl = "";
  let completed = false;
  let choice: "configure" | "environment" | "skip" | undefined = "configure";
  let promptValue: string | undefined = "  http://127.0.0.1:7897  ";
  const calls: string[] = [];
  const services = createProxySetupServices({
    getProxyUrl: () => proxyUrl,
    setProxyUrl: async (value) => { proxyUrl = value; calls.push(`store.proxy:${value}`); },
    hasCompletedOnboarding: () => completed,
    markOnboardingCompleted: async () => { completed = true; calls.push("store.completed"); },
  }, {
    choose: async (onboarding) => { calls.push(`ui.choose:${onboarding}`); return choice; },
    promptProxyUrl: async (defaultValue) => {
      calls.push(`ui.prompt:${defaultValue}`);
      return promptValue;
    },
    showInvalidProxy: async () => { calls.push("ui.invalid"); },
    showReloadRequired: async () => { calls.push("ui.reload"); },
  });

  proxyUrl = "http://proxy.example:8080";
  await services.ensureFirstUse();
  assert.deepEqual(calls, []);

  proxyUrl = "";
  await services.ensureFirstUse();
  assert.equal(proxyUrl, "http://127.0.0.1:7897");
  assert.equal(completed, true);
  assert.deepEqual(calls, [
    "ui.choose:true",
    "ui.prompt:http://127.0.0.1:7897",
    "store.proxy:http://127.0.0.1:7897",
    "store.completed",
    "ui.reload",
  ]);

  calls.length = 0;
  await services.ensureFirstUse();
  assert.deepEqual(calls, []);

  calls.length = 0;
  choice = "environment";
  await services.configure();
  assert.equal(proxyUrl, "");
  assert.deepEqual(calls, [
    "ui.choose:false",
    "store.proxy:",
    "store.completed",
    "ui.reload",
  ]);

  calls.length = 0;
  completed = false;
  choice = "skip";
  await services.ensureFirstUse();
  assert.equal(completed, true);
  assert.deepEqual(calls, ["ui.choose:true", "store.completed"]);

  calls.length = 0;
  completed = false;
  choice = "configure";
  promptValue = "socks5://127.0.0.1:7897";
  await services.ensureFirstUse();
  assert.equal(completed, false);
  assert.deepEqual(calls, [
    "ui.choose:true",
    "ui.prompt:http://127.0.0.1:7897",
    "ui.invalid",
  ]);
}

async function managerRoutesSapProxyBypassConfiguration(): Promise<void> {
  const calls: string[] = [];
  const dependencies = {
    proxySetup: {
      ensureFirstUse: async () => { calls.push("proxy.ensure"); },
      configure: async () => undefined,
    },
    sapProxyBypass: {
      configure: async () => { calls.push("sapProxy.configure"); },
    },
    oauth: {
      signIn: async () => undefined,
      completeManualCallback: async () => undefined,
      signOut: async () => undefined,
      clearSecret: async () => undefined,
    },
    chatgptModels: { refresh: async () => 0, clear: () => undefined },
    local: {
      selectExecutable: async () => undefined,
      start: async () => undefined,
      restart: async () => undefined,
      stop: async () => undefined,
      refreshModels: async () => 0,
      clearModels: () => undefined,
    },
    continuations: { clear: () => undefined },
    diagnostics: {
      show: async () => undefined,
      clear: () => undefined,
      record: () => { calls.push("diagnostics.record"); },
    },
  } satisfies CommandDependencies;
  const ui = {
    confirmPrivateSignIn: async () => true,
    openExternal: async () => true,
    promptManualCallback: async () => undefined,
    selectExecutable: async () => undefined,
    showInformation: async () => undefined,
    showSafeError: async () => { calls.push("ui.error"); },
    selectManagerAction: async () => "configureSapProxyBypass" as ManagerActionId,
    openSettings: async () => undefined,
  } satisfies CommandUi;

  await createCommandServices(dependencies, ui)["copilotCodex.manager"]();

  assert.deepEqual(calls, ["proxy.ensure", "sapProxy.configure"]);
}

async function sapProxyBypassMergesHostsWithoutOverwritingExistingEntries(): Promise<void> {
  let hosts: readonly string[] = ["localhost", "SAP.EXAMPLE.COM", "LOCALHOST"];
  let entered: string | undefined = "sap.example.com, 10.0.0.15\nkic.internal";
  const calls: string[] = [];
  const services = createSapProxyBypassServices({
    getNoProxyHosts: () => hosts,
    setNoProxyHosts: async (value) => {
      hosts = value;
      calls.push(`store.noProxy:${value.join("|")}`);
    },
  }, {
    promptNoProxyHosts: async (defaultValue) => {
      calls.push(`ui.prompt:${defaultValue}`);
      return entered;
    },
    showReloadRequired: async () => { calls.push("ui.reload"); },
  });

  await services.configure();
  assert.deepEqual(hosts, ["localhost", "SAP.EXAMPLE.COM", "10.0.0.15", "kic.internal"]);
  assert.deepEqual(calls, [
    "ui.prompt:localhost, SAP.EXAMPLE.COM",
    "store.noProxy:localhost|SAP.EXAMPLE.COM|10.0.0.15|kic.internal",
    "ui.reload",
  ]);

  calls.length = 0;
  entered = undefined;
  await services.configure();
  assert.deepEqual(hosts, ["localhost", "SAP.EXAMPLE.COM", "10.0.0.15", "kic.internal"]);
  assert.deepEqual(calls, ["ui.prompt:localhost, SAP.EXAMPLE.COM, 10.0.0.15, kic.internal"]);
}

function sapProxyBypassReadsOnlyUserLevelNoProxyEntries(): void {
  type ReadGlobalNoProxyHosts = (configuration: {
    inspect(section: string): {
      globalValue?: readonly string[];
      workspaceValue?: readonly string[];
      workspaceFolderValue?: readonly string[];
    } | undefined;
  }) => readonly string[];
  const readGlobalNoProxyHosts = (
    extensionModule as unknown as { readGlobalNoProxyHosts?: ReadGlobalNoProxyHosts }
  ).readGlobalNoProxyHosts;
  if (readGlobalNoProxyHosts === undefined) {
    assert.fail("readGlobalNoProxyHosts is not implemented");
  }

  assert.deepEqual(readGlobalNoProxyHosts({
    inspect: () => ({
      globalValue: ["global.sap.internal"],
      workspaceValue: ["workspace.sap.internal"],
      workspaceFolderValue: ["folder.sap.internal"],
    }),
  }), ["global.sap.internal"]);
}

async function authenticationRefreshesModelsBeforeReportingSuccess(): Promise<void> {
  const calls: string[] = [];
  const dependencies: CommandDependencies = {
    proxySetup: {
      ensureFirstUse: async () => undefined,
      configure: async () => undefined,
    },
    sapProxyBypass: { configure: async () => undefined },
    oauth: {
      signIn: async () => { calls.push("oauth.signIn"); },
      completeManualCallback: async () => { calls.push("oauth.manual"); },
      signOut: async () => undefined,
      clearSecret: async () => undefined,
    },
    chatgptModels: {
      refresh: async () => { calls.push("chatgpt.refresh"); return 6; },
      clear: () => undefined,
    },
    local: {
      selectExecutable: async () => undefined,
      start: async () => undefined,
      restart: async () => undefined,
      stop: async () => undefined,
      refreshModels: async () => 0,
      clearModels: () => undefined,
    },
    continuations: { clear: () => undefined },
    diagnostics: {
      show: async () => undefined,
      clear: () => undefined,
      record: () => undefined,
    },
  };
  const ui: CommandUi = {
    confirmPrivateSignIn: async () => true,
    openExternal: async () => true,
    promptManualCallback: async () => "http://127.0.0.1:1455/auth/callback?code=ok&state=exact",
    selectExecutable: async () => undefined,
    showInformation: async (message) => { calls.push(`ui.info:${message}`); },
    showSafeError: async () => undefined,
    selectManagerAction: async () => undefined,
    openSettings: async () => undefined,
  };
  const services = createCommandServices(dependencies, ui);

  await services["copilotCodex.chatgpt.signIn"]();
  assert.deepEqual(calls, [
    "oauth.signIn",
    "chatgpt.refresh",
    "ui.info:ChatGPT sign-in completed (6 models).",
  ]);

  calls.length = 0;
  await services["copilotCodex.chatgpt.signInManual"]();
  assert.deepEqual(calls, [
    "oauth.manual",
    "chatgpt.refresh",
    "ui.info:Manual ChatGPT callback completed (6 models).",
  ]);
}

async function chatGptCatalogServicesRefreshAndNotifyAsOneOperation(): Promise<void> {
  const firstModel: CodexModel = {
    id: "gpt-first",
    name: "GPT First",
    family: "gpt",
    version: "1",
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    capabilities: { imageInput: false, toolCalling: true, parallelToolCalls: false },
  };
  const refreshedModel: CodexModel = { ...firstModel, id: "gpt-refreshed", version: "2" };
  let availableModels: readonly CodexModel[] = [firstModel];
  const listOptions: { silent: boolean; forceRefresh?: boolean }[] = [];
  const transport: CodexTransport = {
    listModels: async (options) => {
      listOptions.push(options);
      return availableModels;
    },
    generate: async function* (_request: CodexRequest): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const providerCache = new ModelCache(300_000);
  const transportCache = new ModelCache(300_000);
  const provider = new CodexLanguageModelProvider(transport, {
    modelCache: providerCache,
  });
  const cancellation = new vscode.CancellationTokenSource();
  let changeEvents = 0;
  const subscription = provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents += 1;
  });
  const services = createChatGptModelCatalogServices(provider, transport, transportCache);

  try {
    await provider.provideLanguageModelChatInformation({ silent: true }, cancellation.token);
    await transportCache.get(async () => [firstModel]);
    availableModels = [refreshedModel];

    assert.equal(await services.refresh(), 1);
    const [refreshed] = await provider.provideLanguageModelChatInformation(
      { silent: true },
      cancellation.token,
    );
    assert.equal(refreshed?.id, "gpt-refreshed");
    assert.deepEqual(listOptions.at(-2), { silent: false, forceRefresh: true });
    assert.equal(changeEvents, 1);

    services.clear();
    assert.equal(providerCache.snapshot(), undefined);
    assert.equal(transportCache.snapshot(), undefined);
    assert.equal(changeEvents, 2);
  } finally {
    subscription?.dispose();
    cancellation.dispose();
  }
}

async function idempotentExtensionShutdownSharesAndAwaitsCleanup(): Promise<void> {
  const createDisposer = (extensionModule as unknown as {
    createIdempotentAsyncDisposer?: (
      dispose: () => Promise<void>,
    ) => () => Promise<void>;
  }).createIdempotentAsyncDisposer;
  assert.equal(typeof createDisposer, "function");
  if (createDisposer === undefined) {
    return;
  }

  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispose = createDisposer(async () => {
    calls += 1;
    await pending;
  });
  const first = dispose();
  const second = dispose();
  assert.equal(first, second);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await first;

  const transportCalls: string[] = [];
  const responsiveCleanup = createDisposer(async () => {
    await Promise.allSettled([
      Promise.resolve().then(() => { transportCalls.push("chatgpt"); }),
      Promise.resolve().then(() => { transportCalls.push("local"); }),
      Promise.resolve().then(() => { transportCalls.push("fetch"); }),
    ]);
  });
  assert.equal(await Promise.race([
    responsiveCleanup().then(() => "disposed" as const),
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
  ]), "disposed");
  assert.deepEqual(transportCalls.sort(), ["chatgpt", "fetch", "local"]);

  const deactivation = (extensionModule.deactivate as unknown as () => unknown)();
  assert.ok(deactivation instanceof Promise);
  await deactivation;
}

async function localCatalogServicesRefreshAndNotifyAsOneOperation(): Promise<void> {
  const localModel: CodexModel = {
    id: "local-codex",
    name: "Local Codex",
    family: "codex",
    version: "1",
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    capabilities: { imageInput: false, toolCalling: true, parallelToolCalls: false },
  };
  const providerCache = new ModelCache(300_000);
  const transportCache = new ModelCache(300_000);
  const provider = new CodexLanguageModelProvider({
    listModels: async () => [localModel],
    generate: async function* (): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  }, "local-test", { modelCache: providerCache });
  const forceRefreshCalls: Array<boolean | undefined> = [];
  type LocalModelSession = {
    listModels(forceRefresh?: boolean): Promise<readonly CodexModel[]>;
  };
  const session: LocalModelSession = {
    listModels: async (forceRefresh?: boolean): Promise<readonly CodexModel[]> => {
      forceRefreshCalls.push(forceRefresh);
      return [localModel];
    },
  };
  const services = createLocalModelCatalogServices(
    provider,
    session,
    providerCache,
    transportCache,
  );
  let changeEvents = 0;
  const subscription = provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents += 1;
  });

  try {
    await providerCache.get(async () => [localModel]);
    await transportCache.get(async () => [localModel]);
    assert.equal(await services.refresh(), 1);
    assert.deepEqual(forceRefreshCalls, [true]);
    assert.equal(providerCache.snapshot(), undefined);
    assert.equal(transportCache.snapshot(), undefined);
    assert.equal(changeEvents, 1);

    await providerCache.get(async () => [localModel]);
    await transportCache.get(async () => [localModel]);
    services.clear();
    assert.equal(providerCache.snapshot(), undefined);
    assert.equal(transportCache.snapshot(), undefined);
    assert.equal(changeEvents, 2);
  } finally {
    subscription?.dispose();
  }
}

async function persistedCatalogRestoreUsesSharedDiscoveryAndNotifiesCopilot(): Promise<void> {
  const restoredModel: CodexModel = {
    id: "gpt-restored",
    name: "GPT Restored",
    family: "gpt",
    version: "1",
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    capabilities: { imageInput: false, toolCalling: true, parallelToolCalls: false },
  };
  const listOptions: { silent: boolean; forceRefresh?: boolean }[] = [];
  const transport: CodexTransport = {
    listModels: async (options) => {
      listOptions.push(options);
      return [restoredModel];
    },
    generate: async function* (_request: CodexRequest): AsyncIterable<TransportEvent> {
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
  const provider = new CodexLanguageModelProvider(transport);
  const transportCache = new ModelCache(300_000);
  let changeEvents = 0;
  const subscription = provider.onDidChangeLanguageModelChatInformation?.(() => {
    changeEvents += 1;
  });
  const services = createChatGptModelCatalogServices(provider, transport, transportCache);

  try {
    assert.equal(await services.restore(), 1);
    assert.deepEqual(listOptions, [{ silent: true }]);
    assert.equal(changeEvents, 1);
  } finally {
    subscription?.dispose();
  }
}

async function restoresPersistedCatalogOnlyWhenSessionExists(): Promise<void> {
  const calls: string[] = [];
  await restorePersistedChatGptModelCatalog({
    loadSession: async () => {
      calls.push("session.load");
      return { stored: true };
    },
    restore: async () => {
      calls.push("catalog.restore");
    },
    recordFailure: () => undefined,
  });
  assert.deepEqual(calls, ["session.load", "catalog.restore"]);

  calls.length = 0;
  await restorePersistedChatGptModelCatalog({
    loadSession: async () => {
      calls.push("session.load");
      return undefined;
    },
    restore: async () => {
      calls.push("catalog.restore");
    },
    recordFailure: () => undefined,
  });
  assert.deepEqual(calls, ["session.load"]);
}

async function recordsPersistedCatalogRestoreFailureWithoutRejectingActivation(): Promise<void> {
  const failure = { code: "network" };
  let recordedFailure: unknown;

  await restorePersistedChatGptModelCatalog({
    loadSession: async () => ({ stored: true }),
    restore: async () => { throw failure; },
    recordFailure: (error) => { recordedFailure = error; },
  });

  assert.equal(recordedFailure, failure);
}

function chatGptRequestOverridesReadCurrentSettingsOnEveryCall(): void {
  const values = new Map<string, unknown>();
  const resolveOverrides = createChatGptRequestOverridesResolver({
    get: (section: string) => values.get(section),
  });

  assert.deepEqual(resolveOverrides(), {});
  values.set("chatgpt.reasoningEffort", "high");
  values.set("chatgpt.speedMode", "fast");
  assert.deepEqual(resolveOverrides(), {
    reasoningEffort: "high",
    serviceTier: "priority",
  });
  values.set("chatgpt.reasoningEffort", "modelDefault");
  values.set("chatgpt.speedMode", "modelDefault");
  assert.deepEqual(resolveOverrides(), {});
}

async function manifestContributesOnlySafeManagementSurface(): Promise<void> {
  const extension = vscode.extensions.getExtension("leonbwang.codex-copilot-provider-for-sap");
  assert.ok(extension);
  const packageJson = extension.packageJSON as {
    contributes?: {
      commands?: readonly { command?: string }[];
      configuration?: { properties?: Record<string, Record<string, unknown>> };
    };
  };
  const commandIds = packageJson.contributes?.commands?.map((entry) => entry.command) ?? [];
  assert.deepEqual(commandIds, ["copilotCodex.manager"]);
  await extension.activate();
  const availableCommands = await vscode.commands.getCommands(true);
  for (const id of expectedCommands) {
    assert.ok(availableCommands.includes(id), `missing contributed command: ${id}`);
  }

  const properties = packageJson.contributes?.configuration?.properties ?? {};
  assert.deepEqual(Object.keys(properties), [
    "copilotCodex.local.codexPath",
    "copilotCodex.chatgpt.proxyUrl",
    "copilotCodex.chatgpt.reasoningEffort",
    "copilotCodex.chatgpt.speedMode",
    "copilotCodex.requestTimeoutSeconds",
    "copilotCodex.toolTimeoutSeconds",
    "copilotCodex.catalogCacheMinutes",
    "copilotCodex.sapSelectionMaxChars",
    "copilotCodex.logLevel",
  ]);
  assert.deepEqual(properties["copilotCodex.local.codexPath"], { type: "string", default: "" });
  assert.deepEqual(properties["copilotCodex.chatgpt.proxyUrl"], {
    type: "string",
    default: "",
    pattern: "^$|^https?://",
    description: "Optional HTTP(S) proxy used only for ChatGPT OAuth, model discovery, and responses. Reload VS Code after changing it.",
  });
  assert.deepEqual(properties["copilotCodex.requestTimeoutSeconds"], { type: "number", default: 600, minimum: 10 });
  assert.deepEqual(properties["copilotCodex.toolTimeoutSeconds"], { type: "number", default: 300, minimum: 30 });
  assert.deepEqual(properties["copilotCodex.catalogCacheMinutes"], { type: "number", default: 5, minimum: 1 });
  assert.deepEqual(properties["copilotCodex.sapSelectionMaxChars"], { type: "number", default: 16000, minimum: 1000 });
  assert.deepEqual(properties["copilotCodex.logLevel"], {
    type: "string",
    enum: ["error", "warn", "info", "debug"],
    default: "info",
  });
  assert.doesNotMatch(Object.keys(properties).join("\n"), /endpoint|token|cookie|adt.*token|args|argument|shell|command/i);
}

function diagnosticsAreWhitelistedAndRedacted(): void {
  const history = new DiagnosticsHistory();
  history.record({ code: "network" });
  history.record({ code: "process" });
  history.record(new CodexError("requiredToolMissing"));
  history.record(new Error("private unknown diagnostics failure"));
  assert.deepEqual(history.snapshot(), ["network", "process", "requiredToolMissing"]);
  assert.equal(history.unknownErrorCount(), 1);
  const report = buildDiagnosticsReport({
    extensionVersion: "0.1.0",
    vscodeVersion: "1.131.0",
    platform: "win32-x64",
    chatgpt: { available: true, modelCount: 2, cacheAgeMs: 1_500 },
    local: { available: true, modelCount: 3, cacheAgeMs: 2_500 },
    executablePath: "C:\\Users\\alice\\AppData\\Local\\Programs\\codex.exe",
    appServer: {
      processState: "running",
      serverVersion: "1.2.3",
      dynamicTools: true,
      accountType: "chatgpt",
    },
    sap: { abapFsInstalled: true, adtInstalled: false },
    lastErrorCodes: history.snapshot(),
    unknownErrorCount: 1,
  });

  assert.match(report, /<user>/);
  assert.doesNotMatch(report, /alice|@|access[_ -]?token|cookie|prompt|source|tool.*body|adt:\/\//i);
  assert.match(report, /network/);
  assert.match(report, /process/);
  assert.match(report, /requiredToolMissing/);
  assert.match(report, /"unknownErrorCount": 1/);
  assert.doesNotMatch(report, /private unknown diagnostics failure/);
  assert.match(report, /"processState": "running"/);
  const hostileVersionReport = buildDiagnosticsReport({
    extensionVersion: "0.1.0",
    vscodeVersion: "1.131.0",
    platform: "win32-x64",
    chatgpt: { available: false },
    local: { available: true },
    appServer: {
      processState: "running",
      serverVersion: "1.2.3 Bearer server-version-secret",
      dynamicTools: true,
    },
    sap: { abapFsInstalled: false, adtInstalled: false },
    lastErrorCodes: [],
    unknownErrorCount: 0,
  });
  assert.doesNotMatch(hostileVersionReport, /Bearer|server-version-secret/);
  history.clear();
  assert.deepEqual(history.snapshot(), []);
  assert.equal(history.unknownErrorCount(), 0);
}

export async function runCommandTests(): Promise<void> {
  const tests: readonly [string, () => void | Promise<void>][] = [
    ["commands register exact independent routes", registersExactCommandsAndRoutesIndependently],
    ["idempotent extension shutdown shares and awaits cleanup", idempotentExtensionShutdownSharesAndAwaitsCleanup],
    ["management services preserve route and clear boundaries", managementServicesPreserveRouteAndClearBoundaries],
    ["manager runs first-use proxy setup and allows manual reconfiguration", managerRunsFirstUseProxySetupAndAllowsManualReconfiguration],
    ["manager routes SAP proxy bypass configuration", managerRoutesSapProxyBypassConfiguration],
    ["proxy onboarding persists only explicit safe choices", proxyOnboardingPersistsOnlyExplicitSafeChoices],
    ["SAP proxy bypass merges hosts without overwriting existing entries", sapProxyBypassMergesHostsWithoutOverwritingExistingEntries],
    ["SAP proxy bypass reads only user-level no-proxy entries", sapProxyBypassReadsOnlyUserLevelNoProxyEntries],
    ["authentication refreshes models before reporting success", authenticationRefreshesModelsBeforeReportingSuccess],
    ["ChatGPT catalog services refresh and notify as one operation", chatGptCatalogServicesRefreshAndNotifyAsOneOperation],
    ["Local catalog services refresh and notify as one operation", localCatalogServicesRefreshAndNotifyAsOneOperation],
    ["persisted ChatGPT catalog restore uses shared discovery and notifies Copilot", persistedCatalogRestoreUsesSharedDiscoveryAndNotifiesCopilot],
    ["persisted ChatGPT catalog restores only when a session exists", restoresPersistedCatalogOnlyWhenSessionExists],
    ["persisted ChatGPT catalog restore failure is recorded without rejecting activation", recordsPersistedCatalogRestoreFailureWithoutRejectingActivation],
    ["ChatGPT request overrides read current settings on every call", chatGptRequestOverridesReadCurrentSettingsOnEveryCall],
    ["manifest contributes only safe management settings", manifestContributesOnlySafeManagementSurface],
    ["diagnostics are whitelisted and redacted", diagnosticsAreWhitelistedAndRedacted],
  ];
  for (const [name, execute] of tests) {
    await execute();
    console.log(`✔ ${name}`);
  }
}
