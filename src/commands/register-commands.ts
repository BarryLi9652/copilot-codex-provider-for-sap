import * as vscode from "vscode";

export const COMMAND_IDS = [
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

export type CommandId = typeof COMMAND_IDS[number];
export type CommandServices = Readonly<Record<CommandId, () => Promise<void>>>;

export interface CommandDependencies {
  readonly oauth: {
    signIn(openExternal: (url: string) => Promise<boolean>): Promise<unknown>;
    completeManualCallback(url: string): Promise<unknown>;
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
  return {
    "copilotCodex.chatgpt.signIn": safe(async () => {
      if (!await ui.confirmPrivateSignIn()) {
        return;
      }
      await dependencies.oauth.signIn(async (url) => ui.openExternal(url));
      await ui.showInformation("ChatGPT sign-in completed for this extension.");
    }),
    "copilotCodex.chatgpt.signInManual": safe(async () => {
      const callbackUrl = await ui.promptManualCallback();
      if (callbackUrl === undefined) {
        return;
      }
      await dependencies.oauth.completeManualCallback(callbackUrl);
      await ui.showInformation("Manual ChatGPT callback completed.");
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
