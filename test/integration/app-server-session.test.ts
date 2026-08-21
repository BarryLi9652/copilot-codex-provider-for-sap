import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import type { JsonRpcId } from "../../src/transports/app-server/protocol.js";
import { ProcessSupervisor } from "../../src/transports/app-server/process-supervisor.js";
import { JsonlRpcClient } from "../../src/transports/app-server/jsonl-rpc-client.js";
import {
  APP_SERVER_THREAD_CONFIG,
} from "../../src/transports/app-server/safety-profile.js";
import {
  AppServerSession,
  type AppServerSessionClient,
  type AppServerSessionSupervisor,
} from "../../src/transports/app-server/app-server-session.js";

type RequestCall = { method: string; params: unknown };
type NotificationCall = { method: string; params: unknown };
type ServerRequestHandler = (params: unknown, id: JsonRpcId) => unknown | Promise<unknown>;
type ServerNotificationHandler = (params: unknown) => void | Promise<void>;

const fakeServer = path.resolve(process.cwd(), "scripts", "fake-app-server.mjs");

const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  child.once("exit", () => resolve());
});

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const captureRejection = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
};

const modelList = {
  models: [{
    id: "fake-codex",
    displayName: "Fake Codex",
    description: "Deterministic fake App Server model",
    version: "1.0.0",
    inputTokenLimit: 16_000,
    outputTokenLimit: 4_000,
    inputModalities: ["text", "image"],
    supportsTools: true,
  }],
};

class FakeAppServerClient implements AppServerSessionClient {
  public readonly requests: RequestCall[] = [];
  public readonly notifications: NotificationCall[] = [];
  public readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  public readonly serverNotificationHandlers = new Map<string, ServerNotificationHandler>();
  public accountType: "chatgpt" | "personalAccessToken" | "apiKey" = "chatgpt";
  public initializeExperimentalApi = true;
  public initializeDynamicTools: boolean | undefined = true;
  public initializeFailure: CodexError | undefined;
  public probeFailure: CodexError | undefined;
  public modelCatalog: { models: readonly Record<string, unknown>[] } = modelList;
  public modelListCalls = 0;
  public closed = false;

  public get isClosed(): boolean {
    return this.closed;
  }

  public request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    switch (method) {
      case "initialize":
        if (this.initializeFailure !== undefined) {
          return Promise.reject(this.initializeFailure);
        }
        return Promise.resolve({
          protocolVersion: "1",
          serverInfo: { name: "fake-app-server", version: "1.0.0" },
          capabilities: {
            experimentalApi: this.initializeExperimentalApi,
            ...(this.initializeDynamicTools === undefined
              ? {}
              : { dynamicTools: this.initializeDynamicTools }),
          },
        } as T);
      case "thread/start":
        if (this.probeFailure !== undefined) {
          return Promise.reject(this.probeFailure);
        }
        return Promise.resolve({ thread: { id: "probe-thread" } } as T);
      case "account/read":
        return Promise.resolve({
          account: this.accountType === "apiKey"
            ? { type: "apiKey" }
            : { type: this.accountType, planType: "plus" },
        } as T);
      case "model/list":
        this.modelListCalls += 1;
        return Promise.resolve(this.modelCatalog as T);
      case "turn/interrupt":
        return Promise.resolve({ interrupted: true } as T);
      default:
        return Promise.reject(new CodexError("protocol", { action: method }));
    }
  }

  public notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  public onServerRequest(method: string, handler: ServerRequestHandler): { dispose(): void } {
    this.serverRequestHandlers.set(method, handler);
    return { dispose: () => this.serverRequestHandlers.delete(method) };
  }

  public onServerNotification(method: string, handler: ServerNotificationHandler): { dispose(): void } {
    this.serverNotificationHandlers.set(method, handler);
    return { dispose: () => this.serverNotificationHandlers.delete(method) };
  }

  public dispose(): void {
    this.closed = true;
  }

  public async emitServerRequest(method: string, params: unknown = {}): Promise<unknown> {
    const handler = this.serverRequestHandlers.get(method);
    assert.ok(handler, `missing handler for ${method}`);
    return handler(params, 1);
  }

  public async emitServerNotification(method: string, params: unknown): Promise<void> {
    await this.serverNotificationHandlers.get(method)?.(params);
  }
}

class FakeAppServerSupervisor implements AppServerSessionSupervisor {
  public readonly clients: FakeAppServerClient[];
  public readonly initializationSuccesses: AppServerSessionClient[] = [];
  public readonly initializationFailures: Array<{ client: AppServerSessionClient; cause: unknown }> = [];
  public startCalls = 0;
  public restartCalls = 0;
  public stopCalls = 0;
  private currentClient: FakeAppServerClient;

  public constructor(client = new FakeAppServerClient()) {
    this.clients = [client];
    this.currentClient = client;
  }

  public useForStart(client: FakeAppServerClient): void {
    this.currentClient = client;
  }

  public start(): Promise<AppServerSessionClient> {
    this.startCalls += 1;
    return Promise.resolve(this.currentClient);
  }

  public restart(): Promise<AppServerSessionClient> {
    this.restartCalls += 1;
    const client = new FakeAppServerClient();
    this.clients.push(client);
    this.currentClient = client;
    return Promise.resolve(client);
  }

  public stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  public reportInitializationSuccess(client: AppServerSessionClient): void {
    this.initializationSuccesses.push(client);
  }

  public reportInitializationFailure(client: AppServerSessionClient, cause?: unknown): Promise<void> {
    this.initializationFailures.push({ client, cause });
    return Promise.resolve();
  }
}

class ExactRestartSupervisor implements AppServerSessionSupervisor {
  public readonly firstClient = new FakeAppServerClient();
  public readonly restartClient = new FakeAppServerClient();
  public readonly accidentalStartClient = new FakeAppServerClient();
  public readonly initializationSuccesses: AppServerSessionClient[] = [];
  public readonly initializationFailures: Array<{ client: AppServerSessionClient; cause: unknown }> = [];
  public startCalls = 0;
  public restartCalls = 0;

  public start(): Promise<AppServerSessionClient> {
    this.startCalls += 1;
    return Promise.resolve(this.startCalls === 1 ? this.firstClient : this.accidentalStartClient);
  }

  public restart(): Promise<AppServerSessionClient> {
    this.restartCalls += 1;
    return Promise.resolve(this.restartClient);
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public reportInitializationSuccess(client: AppServerSessionClient): void {
    this.initializationSuccesses.push(client);
  }

  public reportInitializationFailure(client: AppServerSessionClient, cause?: unknown): Promise<void> {
    this.initializationFailures.push({ client, cause });
    return Promise.resolve();
  }
}

class DeferredRestartSupervisor implements AppServerSessionSupervisor {
  public readonly firstClient = new FakeAppServerClient();
  public readonly restartResult = deferred<AppServerSessionClient>();
  public readonly initializationSuccesses: AppServerSessionClient[] = [];
  public readonly initializationFailures: Array<{ client: AppServerSessionClient; cause: unknown }> = [];
  public startCalls = 0;
  public restartCalls = 0;
  public stopCalls = 0;

  public start(): Promise<AppServerSessionClient> {
    this.startCalls += 1;
    return Promise.resolve(this.firstClient);
  }

  public restart(): Promise<AppServerSessionClient> {
    this.restartCalls += 1;
    return this.restartResult.promise;
  }

  public stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  public reportInitializationSuccess(client: AppServerSessionClient): void {
    this.initializationSuccesses.push(client);
  }

  public reportInitializationFailure(client: AppServerSessionClient, cause?: unknown): Promise<void> {
    this.initializationFailures.push({ client, cause });
    return Promise.resolve();
  }
}

test("initializes once, sends initialized, probes dynamic tools, reads account, and caches models", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const client = supervisor.clients[0] as FakeAppServerClient;
  const session = new AppServerSession(supervisor, { extensionVersion: "0.1.0" });

  const [firstCapabilities, secondCapabilities] = await Promise.all([
    session.initialize(),
    session.initialize(),
  ]);

  assert.deepEqual(firstCapabilities, { dynamicTools: true, serverVersion: "1.0.0" });
  assert.deepEqual(secondCapabilities, firstCapabilities);
  assert.equal(supervisor.startCalls, 1);
  assert.deepEqual(client.requests.map(({ method }) => method), [
    "initialize",
    "thread/start",
  ]);
  assert.deepEqual(client.requests[0]?.params, {
    clientInfo: { name: "copilot_codex_provider_for_sap", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  assert.deepEqual(client.notifications, [{ method: "initialized", params: undefined }]);

  const probe = client.requests[1]?.params as typeof APP_SERVER_THREAD_CONFIG & {
    dynamicTools: readonly unknown[];
  };
  assert.deepEqual(probe.approvalPolicy, APP_SERVER_THREAD_CONFIG.approvalPolicy);
  assert.deepEqual(probe.sandbox, APP_SERVER_THREAD_CONFIG.sandbox);
  assert.deepEqual(probe.ephemeral, true);
  assert.equal(probe.dynamicTools.length, 1);

  assert.deepEqual(await session.readAccount(), { type: "chatgpt", planType: "plus" });
  const [firstModels, secondModels] = await Promise.all([
    session.listModels(),
    session.listModels(),
  ]);
  assert.deepEqual(firstModels, secondModels);
  assert.equal(client.modelListCalls, 1);
  assert.deepEqual(firstModels[0], {
    id: "fake-codex",
    name: "Fake Codex",
    family: "fake",
    version: "1.0.0",
    maxInputTokens: 16_000,
    maxOutputTokens: 4_000,
    capabilities: { imageInput: true, toolCalling: true, parallelToolCalls: false },
    description: "Deterministic fake App Server model",
  });
  assert.deepEqual(supervisor.initializationSuccesses, [client]);

  await session.dispose();
});

test("rejects API-key-only accounts and reports the exact client generation on initialization failure", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const client = supervisor.clients[0] as FakeAppServerClient;
  client.accountType = "apiKey";
  const session = new AppServerSession(supervisor, "0.1.0");

  await session.initialize();
  await assert.rejects(
    session.readAccount(),
    (error: unknown) => error instanceof CodexError
      && error.code === "incompatible"
      && error.action === "upgradeCodex",
  );

  const failingSupervisor = new FakeAppServerSupervisor();
  const failingClient = failingSupervisor.clients[0] as FakeAppServerClient;
  failingClient.request = async <T>(method: string, params?: unknown): Promise<T> => {
    failingClient.requests.push({ method, params });
    if (method === "initialize") {
      return {
        protocolVersion: "1",
        serverInfo: { name: "fake-app-server", version: "1.0.0" },
        capabilities: { experimentalApi: true, dynamicTools: false },
      } as T;
    }
    throw new CodexError("protocol", {
      action: method,
      cause: method === "thread/start"
        ? { code: -32602, message: "dynamicTools is unavailable" }
        : undefined,
    });
  };
  const failingSession = new AppServerSession(failingSupervisor, "0.1.0");

  await assert.rejects(
    failingSession.initialize(),
    (error: unknown) => error instanceof CodexError
      && error.code === "incompatible"
      && error.action === "upgradeCodex",
  );
  assert.deepEqual(failingClient.requests.map(({ method }) => method), [
    "initialize",
    "thread/start",
  ]);
  assert.equal(failingSupervisor.initializationFailures.length, 1);
  assert.equal(failingSupervisor.initializationFailures[0]?.client, failingClient);
  assert.ok(failingSupervisor.initializationFailures[0]?.cause instanceof CodexError);
  await session.dispose();
  await failingSession.dispose();
});

test("accepts personal access token accounts through account/read", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const client = supervisor.clients[0] as FakeAppServerClient;
  client.accountType = "personalAccessToken";
  const session = new AppServerSession(supervisor, "0.1.0");

  await session.initialize();
  assert.deepEqual(await session.readAccount(), {
    type: "personalAccessToken",
    planType: "plus",
  });

  await session.dispose();
});

test("latches incompatible initialization failures until an explicit restart", async () => {
  const cases: Array<(client: FakeAppServerClient) => void> = [
    (client) => {
      client.initializeExperimentalApi = false;
    },
    (client) => {
      client.probeFailure = new CodexError("protocol", {
        action: "thread/start",
        cause: { code: -32602, message: "dynamicTools is unavailable" },
      });
    },
    (client) => {
      client.initializeFailure = new CodexError("protocol", {
        action: "initialize",
        cause: { code: -32602, message: "experimentalApi is not supported" },
      });
    },
  ];

  for (const configureFailure of cases) {
    const supervisor = new FakeAppServerSupervisor();
    const client = supervisor.clients[0] as FakeAppServerClient;
    configureFailure(client);
    const session = new AppServerSession(supervisor, "0.1.0");

    const first = await captureRejection(session.listModels());
    assert.ok(first instanceof CodexError);
    assert.equal(first.code, "incompatible");
    assert.equal(first.action, "upgradeCodex");
    const second = await captureRejection(session.listModels());
    const third = await captureRejection(session.readAccount());
    assert.strictEqual(second, first);
    assert.strictEqual(third, first);
    assert.equal(supervisor.startCalls, 1);
    assert.equal(client.requests.filter(({ method }) => method === "initialize").length, 1);
    assert.equal(client.modelListCalls, 0);

    await session.restart();
    assert.equal(supervisor.startCalls, 1);
    assert.deepEqual((await session.listModels()).map((model) => model.id), ["fake-codex"]);
    await session.dispose();
  }
});

test("lets the successful dynamic-tool probe establish capability after a false initialize hint", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const client = supervisor.clients[0] as FakeAppServerClient;
  client.initializeDynamicTools = false;
  const session = new AppServerSession(supervisor, "0.1.0");

  assert.deepEqual(await session.initialize(), { dynamicTools: true, serverVersion: "1.0.0" });
  assert.deepEqual(client.requests.map(({ method }) => method), [
    "initialize",
    "thread/start",
  ]);

  await session.dispose();
});

test("registers deny handlers and interrupts native command or file items without content", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const client = supervisor.clients[0] as FakeAppServerClient;
  const session = new AppServerSession(supervisor, "0.1.0");
  await session.initialize();

  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/permission/requestApproval",
  ]) {
    assert.equal(await client.emitServerRequest(method), "deny");
  }

  await client.emitServerNotification("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "commandExecution" },
  });
  await client.emitServerNotification("item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { type: "fileChange" },
  });

  assert.equal(session.hasSecurityProtocolFailure, true);
  assert.deepEqual(client.requests.filter(({ method }) => method === "turn/interrupt").map(({ params }) => params), [
    { threadId: "thread-1", turnId: "turn-1" },
    { threadId: "thread-1", turnId: "turn-1" },
  ]);
  await session.dispose();
});

test("keeps model caches isolated and restart creates a fresh initialized generation", async () => {
  const firstSupervisor = new FakeAppServerSupervisor();
  const secondSupervisor = new FakeAppServerSupervisor();
  const first = new AppServerSession(firstSupervisor, "0.1.0");
  const second = new AppServerSession(secondSupervisor, "0.1.0");

  await Promise.all([first.listModels(), second.listModels()]);
  assert.equal((firstSupervisor.clients[0] as FakeAppServerClient).modelListCalls, 1);
  assert.equal((secondSupervisor.clients[0] as FakeAppServerClient).modelListCalls, 1);

  await first.restart();
  const replacement = firstSupervisor.clients[1] as FakeAppServerClient;
  await first.listModels();
  assert.equal(firstSupervisor.restartCalls, 1);
  assert.equal(replacement.modelListCalls, 1);
  assert.equal(firstSupervisor.initializationSuccesses.length, 2);

  await first.dispose();
  await first.dispose();
  await second.dispose();
  assert.equal(firstSupervisor.stopCalls, 1);
  await assert.rejects(first.initialize(), (error: unknown) => error instanceof CodexError && error.code === "cancelled");
});

test("initializes the exact client returned by supervisor.restart", async () => {
  const supervisor = new ExactRestartSupervisor();
  const session = new AppServerSession(supervisor, "0.1.0");

  await session.initialize();
  await session.restart();

  assert.equal(supervisor.startCalls, 1);
  assert.equal(supervisor.restartCalls, 1);
  assert.deepEqual(supervisor.restartClient.requests.map(({ method }) => method), [
    "initialize",
    "thread/start",
  ]);
  assert.equal(supervisor.accidentalStartClient.requests.length, 0);
  assert.deepEqual(supervisor.initializationSuccesses, [
    supervisor.firstClient,
    supervisor.restartClient,
  ]);
  assert.equal(supervisor.firstClient.serverRequestHandlers.size, 0);
  assert.equal(supervisor.firstClient.serverNotificationHandlers.size, 0);
  assert.equal(supervisor.restartClient.serverRequestHandlers.size, 6);
  assert.equal(supervisor.restartClient.serverNotificationHandlers.size, 7);

  await session.dispose();
});

test("invalidates model cache before returning models from a reinitialized client", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const firstClient = supervisor.clients[0] as FakeAppServerClient;
  firstClient.modelCatalog = {
    models: [{
      id: "first-generation",
      displayName: "First generation",
      inputTokenLimit: 1_000,
      outputTokenLimit: 500,
    }],
  };
  const replacementClient = new FakeAppServerClient();
  replacementClient.modelCatalog = {
    models: [{
      id: "replacement-generation",
      displayName: "Replacement generation",
      inputTokenLimit: 2_000,
      outputTokenLimit: 1_000,
    }],
  };
  const session = new AppServerSession(supervisor, "0.1.0");

  assert.deepEqual((await session.listModels()).map((model) => model.id), ["first-generation"]);
  supervisor.useForStart(replacementClient);
  firstClient.closed = true;

  assert.deepEqual((await session.listModels()).map((model) => model.id), ["replacement-generation"]);
  assert.equal(firstClient.modelListCalls, 1);
  assert.equal(replacementClient.modelListCalls, 1);

  await session.dispose();
});

test("dispose waits for a deferred restart and prevents replacement initialization", async () => {
  const supervisor = new DeferredRestartSupervisor();
  const session = new AppServerSession(supervisor, "0.1.0");
  await session.initialize();

  const restart = session.restart();
  assert.strictEqual(session.restart(), restart);
  await new Promise<void>((resolve) => setImmediate(resolve));

  let disposeSettled = false;
  const dispose = session.dispose().then(() => {
    disposeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposeSettled, false);

  const replacement = new FakeAppServerClient();
  supervisor.restartResult.resolve(replacement);
  await assert.rejects(
    restart,
    (error: unknown) => error instanceof CodexError && error.code === "cancelled",
  );
  await dispose;
  assert.equal(supervisor.startCalls, 1);
  assert.equal(replacement.requests.length, 0);
  assert.deepEqual(supervisor.initializationSuccesses, [supervisor.firstClient]);
  assert.equal(supervisor.stopCalls, 1);
});

test("maps only clear dynamic-tool rejection to incompatible and preserves unrelated failures", async () => {
  const unsupported = new CodexError("protocol", {
    action: "thread/start",
    cause: { code: -32602, message: "dynamicTools is unavailable: private server detail" },
  });
  const unsupportedSupervisor = new FakeAppServerSupervisor();
  const unsupportedClient = unsupportedSupervisor.clients[0] as FakeAppServerClient;
  unsupportedClient.probeFailure = unsupported;
  const unsupportedSession = new AppServerSession(unsupportedSupervisor, "0.1.0");
  const incompatible = await captureRejection(unsupportedSession.initialize());
  assert.ok(incompatible instanceof CodexError);
  assert.equal(incompatible.code, "incompatible");
  assert.equal(incompatible.action, "upgradeCodex");
  assert.equal(String(incompatible).includes("private server detail"), false);
  await unsupportedSession.dispose();

  const unrelatedCases: Array<{ error: CodexError; code: CodexError["code"] }> = [
    {
      error: new CodexError("protocol", {
        action: "thread/start",
        cause: { code: -32602, message: "sandbox configuration is invalid" },
      }),
      code: "protocol",
    },
    { error: new CodexError("network", { action: "thread/start" }), code: "network" },
    { error: new CodexError("process", { action: "thread/start" }), code: "process" },
  ];
  for (const { error, code } of unrelatedCases) {
    const supervisor = new FakeAppServerSupervisor();
    const client = supervisor.clients[0] as FakeAppServerClient;
    client.probeFailure = error;
    const session = new AppServerSession(supervisor, "0.1.0");
    const actual = await captureRejection(session.initialize());
    assert.strictEqual(actual, error);
    assert.ok(actual instanceof CodexError);
    assert.equal(actual.code, code);
    assert.equal(String(actual).includes("sandbox configuration"), false);
    await session.dispose();
  }
});

test("fails safe when the App Server client cannot receive notifications", async () => {
  const supervisor = new FakeAppServerSupervisor();
  const client = supervisor.clients[0] as FakeAppServerClient;
  (client as unknown as { onServerNotification?: unknown }).onServerNotification = undefined;
  const session = new AppServerSession(supervisor, "0.1.0");

  const error = await captureRejection(session.initialize());
  assert.ok(error instanceof CodexError);
  assert.equal(error.code, "incompatible");
  assert.equal(error.action, "upgradeCodex");
  assert.deepEqual(client.requests, []);
  assert.equal(supervisor.initializationFailures.length, 1);

  await session.dispose();
});

test("initializes and discovers models through the deterministic fake App Server", async () => {
  let child: ChildProcess | undefined;
  const supervisor = new ProcessSupervisor({
    configuredExecutable: process.execPath,
    cwd: process.cwd(),
    env: { ...process.env },
    killGraceMs: 20,
    forceKillWaitMs: 40,
    spawnProcess: (_executable, _args, options) => {
      child = spawn(process.execPath, [fakeServer], options);
      return child;
    },
  });
  const session = new AppServerSession(supervisor, { extensionVersion: "0.1.0" });

  const capabilities = await session.initialize();
  assert.deepEqual(capabilities, { dynamicTools: true, serverVersion: "1.0.0" });
  assert.deepEqual(await session.readAccount(), { type: "chatgpt", planType: "plus" });
  assert.deepEqual((await session.listModels()).map((model) => model.id), ["fake-codex"]);

  await session.dispose();
  await waitForExit(child as ChildProcess);
});

test("maps fake-server dynamic-tool rejection to manual upgrade recovery", async () => {
  let child: ChildProcess | undefined;
  const supervisor = new ProcessSupervisor({
    configuredExecutable: process.execPath,
    cwd: process.cwd(),
    env: { ...process.env, FAKE_APP_SERVER_NO_DYNAMIC_TOOLS: "1" },
    killGraceMs: 20,
    forceKillWaitMs: 40,
    spawnProcess: (_executable, _args, options) => {
      child = spawn(process.execPath, [fakeServer], options);
      return child;
    },
  });
  const session = new AppServerSession(supervisor, "0.1.0");

  await assert.rejects(
    session.initialize(),
    (error: unknown) => error instanceof CodexError
      && error.code === "incompatible"
      && error.action === "upgradeCodex",
  );

  await session.dispose();
  await waitForExit(child as ChildProcess);
});

test("interrupts an id-less native item/started notification at the JSONL boundary", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient({
    input: clientInput,
    output: serverOutput,
  });
  clientInput.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
    if (request.id === undefined) {
      return;
    }
    const result = request.method === "initialize"
      ? {
        protocolVersion: "1",
        serverInfo: { name: "inline-fake", version: "1.0.0" },
        capabilities: { experimentalApi: true, dynamicTools: true },
      }
      : { thread: { id: "probe-thread" } };
    serverOutput.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });

  const supervisor: AppServerSessionSupervisor = {
    start: async () => client,
    restart: async () => client,
    stop: async () => { client.dispose(); },
    reportInitializationSuccess: () => undefined,
    reportInitializationFailure: async () => undefined,
  };
  const session = new AppServerSession(supervisor, "0.1.0");
  await session.initialize();

  serverOutput.write(`${JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution" },
    },
  })}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(session.hasSecurityProtocolFailure, true);
  await session.dispose();
  clientInput.destroy();
  serverOutput.destroy();
});
