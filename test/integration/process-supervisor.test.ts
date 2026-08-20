import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { SafeLogger } from "../../src/security/logger.js";
import { ProcessSupervisor } from "../../src/transports/app-server/process-supervisor.js";

const fakeServer = path.resolve(process.cwd(), "scripts", "fake-app-server.mjs");

const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  child.once("exit", () => resolve());
});

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(() => resolve(), milliseconds));
};

type KillMode = "any" | "force-only" | "never";

class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout: PassThrough | null;
  public readonly stderr = new PassThrough();
  public readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  public pid = 30_000;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public exitedAt: number | undefined;

  public constructor(
    private readonly killMode: KillMode = "any",
    stdout: PassThrough | null = new PassThrough(),
    private readonly killDelayMs = 0,
  ) {
    super();
    this.stdout = stdout;
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    const shouldExit = this.killMode === "any"
      || (this.killMode === "force-only" && signal === "SIGKILL");
    if (shouldExit) {
      setTimeout(() => this.exit(0, typeof signal === "string" ? signal : null), this.killDelayMs);
    }
    return true;
  }

  public exit(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.exitedAt = Date.now();
    this.emit("exit", code, signal);
  }
}

const asChildProcess = (child: FakeChild): ChildProcess => child as unknown as ChildProcess;

type SupervisorClient = Awaited<ReturnType<ProcessSupervisor["start"]>>;

interface FixRoundSupervisor extends ProcessSupervisor {
  dispose(): Promise<void>;
  reportInitializationFailure(client: SupervisorClient, cause?: unknown): Promise<void>;
  reportInitializationSuccess(client: SupervisorClient): void;
}

const asFixRoundSupervisor = (supervisor: ProcessSupervisor): FixRoundSupervisor =>
  supervisor as FixRoundSupervisor;

const injectedSupervisor = (
  spawnChild: (count: number) => FakeChild,
  options: Partial<ConstructorParameters<typeof ProcessSupervisor>[0]> = {},
): { supervisor: ProcessSupervisor; children: FakeChild[] } => {
  const children: FakeChild[] = [];
  const supervisorOptions = {
    configuredExecutable: process.execPath,
    cwd: process.cwd(),
    env: { ...process.env },
    killGraceMs: 10,
    forceKillWaitMs: 20,
    ...options,
    spawnProcess: () => {
      const child = spawnChild(children.length + 1);
      children.push(child);
      return asChildProcess(child);
    },
  } as ConstructorParameters<typeof ProcessSupervisor>[0];
  const supervisor = new ProcessSupervisor(supervisorOptions);
  return { supervisor, children };
};

test("starts the fake App Server with exact stdio argv and stops without an orphan", async () => {
  let receivedExecutable = "";
  let receivedArgs: readonly string[] = [];
  let receivedOptions: SpawnOptions | undefined;
  let child: ChildProcess | undefined;
  const supervisor = new ProcessSupervisor({
    configuredExecutable: process.execPath,
    cwd: process.cwd(),
    env: { ...process.env },
    spawnProcess: (executable, args, options) => {
      receivedExecutable = executable;
      receivedArgs = args;
      receivedOptions = options;
      child = spawn(process.execPath, [fakeServer], options);
      return child;
    },
  });

  const client = await supervisor.start();
  assert.equal(receivedExecutable, process.execPath);
  assert.deepEqual(receivedArgs, ["app-server", "--listen", "stdio://"]);
  assert.equal(receivedOptions?.shell, false);
  assert.equal(receivedOptions?.windowsHide, true);
  assert.deepEqual(receivedOptions?.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(receivedOptions?.cwd, process.cwd());
  const initialized = await client.request<{
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    capabilities: { experimentalApi: boolean; dynamicTools: boolean };
  }>("initialize", {});
  assert.equal(initialized.protocolVersion, "1");
  assert.deepEqual(initialized.serverInfo, { name: "fake-app-server", version: "1.0.0" });
  assert.deepEqual(initialized.capabilities, { experimentalApi: true, dynamicTools: true });

  await supervisor.stop();
  await waitForExit(child as ChildProcess);
  assert.notEqual((child as ChildProcess).exitCode, null);
  await supervisor.stop();
});

test("allows one crash restart, opens the breaker after the next failure, and resets with restart", async () => {
  let spawnCount = 0;
  const children: ChildProcess[] = [];
  const supervisor = new ProcessSupervisor({
    configuredExecutable: process.execPath,
    cwd: process.cwd(),
    env: { ...process.env },
    spawnProcess: (_executable, _args, options) => {
      spawnCount += 1;
      const environment = {
        ...options.env,
        ...(spawnCount <= 2 ? { FAKE_APP_SERVER_CRASH_AFTER_INIT: "1" } : {}),
      };
      const child = spawn(process.execPath, [fakeServer], { ...options, env: environment });
      children.push(child);
      return child;
    },
  });

  const first = await supervisor.start();
  await first.request("initialize", {});
  await waitForExit(children[0] as ChildProcess);

  const second = await supervisor.start();
  await second.request("initialize", {});
  await waitForExit(children[1] as ChildProcess);

  await assert.rejects(
    supervisor.start(),
    (error: unknown) => {
      assert.ok(error instanceof CodexError);
      assert.equal(error.code, "process");
      assert.equal(String(error).includes("private"), false);
      return true;
    },
  );

  const third = await supervisor.restart();
  const initialized = await third.request<{
    protocolVersion: string;
    serverInfo: { name: string; version: string };
  }>("initialize", {});
  assert.equal(initialized.protocolVersion, "1");
  assert.deepEqual(initialized.serverInfo, { name: "fake-app-server", version: "1.0.0" });
  await supervisor.stop();
  await Promise.all(children.map(waitForExit));
  assert.equal(spawnCount, 3);
});

test("records only stderr metadata and never includes stderr content in diagnostics", async () => {
  const logLines: string[] = [];
  const logger = new SafeLogger(
    { appendLine: (value: string) => logLines.push(value) },
    () => "debug",
  );
  const supervisor = new ProcessSupervisor({
    configuredExecutable: process.execPath,
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_APP_SERVER_STDERR: "private prompt, token, and ABAP source",
    },
    logger,
    spawnProcess: (_executable, _args, options) => spawn(process.execPath, [fakeServer], options),
  });

  const client = await supervisor.start();
  await client.request("initialize", {});
  await supervisor.stop();

  assert.ok(logLines.length > 0);
  assert.equal(logLines.some((line) => line.includes("private prompt")), false);
  const metadata = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(metadata.some((entry) => entry.event === "appServer.stderr"));
  assert.ok(metadata.every((entry) => typeof entry.bytes === "number"));
});

test("does not let an old child error close or clear a newer generation", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("any"));
  const first = await supervisor.start();
  await supervisor.stop();
  const second = await supervisor.restart();
  const oldChild = children[0] as FakeChild;
  oldChild.emit("error", new Error("late old child error"));
  oldChild.stderr.emit("data", "late old stderr");
  assert.doesNotThrow(() => {
    oldChild.stderr.emit("error", new Error("late old stderr error"));
  });
  oldChild.emit("exit", 1, null);

  assert.equal(await supervisor.start(), second);
  assert.equal(second.isClosed, false);
  assert.notEqual(first, second);
  await supervisor.stop();
});

test("failed start kills and waits for the exact child before rejecting", async () => {
  const child = new FakeChild("any", null, 20);
  const { supervisor } = injectedSupervisor(() => child);
  const startedAt = Date.now();

  await assert.rejects(
    supervisor.start(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  assert.ok(child.exitedAt !== undefined);
  assert.ok(child.exitedAt >= startedAt + 15);
  assert.deepEqual(child.killCalls, [undefined]);
});

test("escalates from graceful kill to SIGKILL when graceful kill is ignored", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("force-only"));
  await supervisor.start();
  const stopping = supervisor.stop();
  await stopping;
  assert.deepEqual((children[0] as FakeChild).killCalls, [undefined, "SIGKILL"]);
  assert.equal((children[0] as FakeChild).exitCode, 0);
  await supervisor.stop();
});

test("returns a typed process error after bounded force-kill failure and does not spawn over a live child", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("never"));
  await supervisor.start();
  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  assert.deepEqual((children[0] as FakeChild).killCalls, [undefined, "SIGKILL"]);
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  (children[0] as FakeChild).exit();
});

test("does not spawn a new child while the prior child is still terminating", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("any", new PassThrough(), 20));
  await supervisor.start();
  const stopping = supervisor.stop();
  const starting = supervisor.start();
  await stopping;
  const second = await starting;

  assert.equal(children.length, 2);
  assert.ok((children[0] as FakeChild).exitedAt !== undefined);
  await supervisor.stop();
  assert.equal(second.isClosed, true);
});

test("shares one concurrent start promise and exposes idempotent dispose", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("any"));
  const firstStart = supervisor.start();
  const secondStart = supervisor.start();
  const [first, second] = await Promise.all([firstStart, secondStart]);
  assert.equal(first, second);
  assert.equal(children.length, 1);
  await asFixRoundSupervisor(supervisor).dispose();
  await asFixRoundSupervisor(supervisor).dispose();
});

test("tracks initialization failures, resets after success, and ignores stale client reports", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("any"));
  const first = await supervisor.start();
  await asFixRoundSupervisor(supervisor).reportInitializationFailure(first, new Error("first init failed"));

  const second = await supervisor.start();
  asFixRoundSupervisor(supervisor).reportInitializationSuccess(second);
  (children[1] as FakeChild).exit(1);
  await wait(1);

  const third = await supervisor.start();
  await asFixRoundSupervisor(supervisor).reportInitializationFailure(first, new Error("stale failure"));
  assert.equal(await supervisor.start(), third);

  await asFixRoundSupervisor(supervisor).reportInitializationFailure(third, new Error("second init failed"));
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
  const reset = await supervisor.restart();
  asFixRoundSupervisor(supervisor).reportInitializationSuccess(reset);
  await asFixRoundSupervisor(supervisor).dispose();
});

test("handles a child error as a generation-owned failure and permits one restart", async () => {
  const { supervisor, children } = injectedSupervisor(() => new FakeChild("any"));
  const first = await supervisor.start();
  (children[0] as FakeChild).emit("error", new Error("child error"));
  await wait(1);
  const second = await supervisor.start();

  assert.notEqual(first, second);
  assert.equal(children.length, 2);
  await asFixRoundSupervisor(supervisor).dispose();
});
