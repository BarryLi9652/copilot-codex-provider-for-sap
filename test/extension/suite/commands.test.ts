import assert from "node:assert/strict";

import * as vscode from "vscode";

import {
  COMMAND_IDS,
  createCommandServices,
  registerCommands,
  type CommandDependencies,
  type CommandServices,
  type CommandUi,
} from "../../../src/commands/register-commands.js";
import {
  buildDiagnosticsReport,
  DiagnosticsHistory,
} from "../../../src/commands/diagnostics.js";

const expectedCommands = [
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
  let manualCallback: string | undefined;
  let openedAuthorizationUrl: string | undefined;
  const dependencies: CommandDependencies = {
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
  };
  const services = createCommandServices(dependencies, ui);

  await services["copilotCodex.chatgpt.signIn"]();
  await services["copilotCodex.chatgpt.signInManual"]();
  await services["copilotCodex.local.selectExecutable"]();
  assert.equal(openedAuthorizationUrl, "https://auth.example/authorize");
  assert.equal(manualCallback, completeCallback);
  assert.deepEqual(calls, [
    "oauth.signIn",
    "oauth.manual",
    "local.select:C:\\Tools\\codex.exe",
  ]);

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

async function manifestContributesOnlySafeManagementSurface(): Promise<void> {
  const extension = vscode.extensions.getExtension("leonbwang.copilot-codex-provider-for-sap");
  assert.ok(extension);
  const packageJson = extension.packageJSON as {
    contributes?: {
      commands?: readonly { command?: string }[];
      configuration?: { properties?: Record<string, Record<string, unknown>> };
    };
  };
  const commandIds = packageJson.contributes?.commands?.map((entry) => entry.command) ?? [];
  assert.deepEqual(commandIds, expectedCommands);
  await extension.activate();
  const availableCommands = await vscode.commands.getCommands(true);
  for (const id of expectedCommands) {
    assert.ok(availableCommands.includes(id), `missing contributed command: ${id}`);
  }

  const properties = packageJson.contributes?.configuration?.properties ?? {};
  assert.deepEqual(Object.keys(properties), [
    "copilotCodex.local.codexPath",
    "copilotCodex.requestTimeoutSeconds",
    "copilotCodex.toolTimeoutSeconds",
    "copilotCodex.catalogCacheMinutes",
    "copilotCodex.sapSelectionMaxChars",
    "copilotCodex.logLevel",
  ]);
  assert.deepEqual(properties["copilotCodex.local.codexPath"], { type: "string", default: "" });
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
  });

  assert.match(report, /<user>/);
  assert.doesNotMatch(report, /alice|@|access[_ -]?token|cookie|prompt|source|tool.*body|adt:\/\//i);
  assert.match(report, /network/);
  assert.match(report, /process/);
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
  });
  assert.doesNotMatch(hostileVersionReport, /Bearer|server-version-secret/);
  history.clear();
  assert.deepEqual(history.snapshot(), []);
}

export async function runCommandTests(): Promise<void> {
  const tests: readonly [string, () => void | Promise<void>][] = [
    ["commands register exact independent routes", registersExactCommandsAndRoutesIndependently],
    ["management services preserve route and clear boundaries", managementServicesPreserveRouteAndClearBoundaries],
    ["manifest contributes only safe management settings", manifestContributesOnlySafeManagementSurface],
    ["diagnostics are whitelisted and redacted", diagnosticsAreWhitelistedAndRedacted],
  ];
  for (const [name, execute] of tests) {
    await execute();
    console.log(`✔ ${name}`);
  }
}
