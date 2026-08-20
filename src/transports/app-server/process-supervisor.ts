import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";

import { CodexError } from "../../core/errors.js";
import { SafeLogger } from "../../security/logger.js";
import { JsonlRpcClient } from "./jsonl-rpc-client.js";
import { ExecutableLocator, type ExecutableFileSystem } from "./executable-locator.js";
import { processError } from "./protocol.js";

export type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type SupervisorTimer = ReturnType<typeof setTimeout>;
type SupervisorSetTimeout = (callback: () => void, milliseconds: number) => SupervisorTimer;
type SupervisorClearTimeout = (timer: SupervisorTimer) => void;

export interface ProcessSupervisorOptions {
  configuredExecutable?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  fileSystem?: ExecutableFileSystem;
  requestTimeoutMs?: number;
  killGraceMs?: number;
  forceKillWaitMs?: number;
  setTimeout?: SupervisorSetTimeout;
  clearTimeout?: SupervisorClearTimeout;
  logger?: SafeLogger;
  spawnProcess?: SpawnProcess;
}

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 1_000;

const isClosedStream = (
  stream: { destroyed?: boolean; closed?: boolean } | null,
): boolean => stream === null || stream.destroyed === true || stream.closed === true;

type ChildExitSignal = NodeJS.Signals | null;

interface ChildRecord {
  readonly generation: number;
  readonly child: ChildProcess;
  readonly exitPromise: Promise<void>;
  readonly resolveExit: () => void;
  readonly spawnPromise: Promise<void>;
  readonly resolveSpawn: () => void;
  readonly rejectSpawn: (reason: unknown) => void;
  readonly onExit: (code: number | null, signal: ChildExitSignal) => void;
  readonly onError: (cause: Error) => void;
  readonly onStdinError: (cause: Error) => void;
  readonly onStdoutError: (cause: Error) => void;
  readonly onStderr: (chunk: Buffer | string) => void;
  readonly onStderrError: (cause: Error) => void;
  readonly onSpawn: () => void;
  readonly onSpawnError: (cause: Error) => void;
  readonly onExitBeforeSpawn: () => void;
  readonly onChildClose: () => void;
  readonly onStdinClose: () => void;
  readonly onStdoutClose: () => void;
  readonly onStderrClose: () => void;
  spawnSettled: boolean;
  exitObserved: boolean;
  childClosed: boolean;
  stdinClosed: boolean;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  listenersRemoved: boolean;
  state: "starting" | "running" | "terminating" | "stuck" | "exited";
  intentionalTermination: boolean;
  failureRecorded: boolean;
  client: JsonlRpcClient | undefined;
  terminationPromise: Promise<void> | undefined;
}

export class ProcessSupervisor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly safeCwd: string;
  private readonly killGraceMs: number;
  private readonly forceKillWaitMs: number;
  private readonly setTimeout: SupervisorSetTimeout;
  private readonly clearTimeout: SupervisorClearTimeout;
  private readonly logger: SafeLogger | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly locator: ExecutableLocator;
  private readonly spawnProcess: SpawnProcess;
  private currentRecord: ChildRecord | undefined;
  private nextGeneration = 1;
  private startPromise: Promise<JsonlRpcClient> | undefined;
  private stopPromise: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private breakerOpen = false;

  public constructor(options: ProcessSupervisorOptions = {}) {
    this.env = options.env ?? { ...process.env };
    this.safeCwd = path.resolve(options.cwd ?? process.cwd());
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.forceKillWaitMs = options.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;
    if (!Number.isFinite(this.killGraceMs) || this.killGraceMs <= 0) {
      throw new RangeError("killGraceMs must be positive");
    }
    if (!Number.isFinite(this.forceKillWaitMs) || this.forceKillWaitMs <= 0) {
      throw new RangeError("forceKillWaitMs must be positive");
    }
    this.setTimeout = options.setTimeout ?? ((callback, milliseconds) =>
      setTimeout(callback, milliseconds));
    this.clearTimeout = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.locator = new ExecutableLocator({
      configuredExecutable: options.configuredExecutable,
      env: this.env,
      platform: options.platform,
      fileSystem: options.fileSystem,
    });
    this.spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) =>
      spawn(executable, args, spawnOptions));
  }

  public start(): Promise<JsonlRpcClient> {
    const record = this.currentRecord;
    if (this.startPromise !== undefined) {
      if (
        this.stopPromise !== undefined
        || record?.state === "terminating"
        || record?.intentionalTermination
      ) {
        return Promise.reject(processError("startCodex"));
      }
      return this.startPromise;
    }
    if (this.breakerOpen) {
      return Promise.reject(processError("startCodex"));
    }

    if (record?.state === "running" && record.client !== undefined && !record.client.isClosed) {
      return Promise.resolve(record.client);
    }

    let operation!: Promise<JsonlRpcClient>;
    operation = this.startInternal().finally(() => {
      if (this.startPromise === operation) {
        this.startPromise = undefined;
      }
    });
    this.startPromise = operation;
    return operation;
  }

  public async restart(): Promise<JsonlRpcClient> {
    this.breakerOpen = false;
    this.consecutiveFailures = 0;
    await this.stop();
    return this.start();
  }

  public stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    let operation!: Promise<void>;
    operation = this.stopInternal().finally(() => {
      if (this.stopPromise === operation) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = operation;
    return operation;
  }

  public dispose(): Promise<void> {
    return this.stop();
  }

  public reportInitializationSuccess(client: JsonlRpcClient): void {
    const record = this.currentRecord;
    if (record === undefined || record.client !== client || record.state !== "running") {
      return;
    }
    this.consecutiveFailures = 0;
    this.breakerOpen = false;
  }

  public reportInitializationFailure(
    client: JsonlRpcClient,
    cause?: unknown,
  ): Promise<void> {
    const record = this.currentRecord;
    if (record === undefined || record.client !== client) {
      return Promise.resolve();
    }
    this.recordFailure(record);
    return this.terminateRecord(record, processError("initializeCodex", cause), false);
  }

  private async startInternal(): Promise<JsonlRpcClient> {
    if (this.breakerOpen) {
      throw processError("startCodex");
    }

    const existing = this.currentRecord;
    if (existing !== undefined) {
      if (existing.state === "running" && existing.client !== undefined && !existing.client.isClosed) {
        return existing.client;
      }
      if (existing.terminationPromise === undefined) {
        await this.terminateRecord(existing, processError("replaceCodex"), false);
      } else {
        await existing.terminationPromise;
      }
      if (this.currentRecord !== undefined) {
        throw processError("replaceCodex");
      }
    }

    let executable: string;
    try {
      executable = this.locator.resolve();
    } catch (cause) {
      this.recordFailure();
      throw cause instanceof CodexError ? cause : processError("selectCodex", cause);
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(executable, APP_SERVER_ARGS, {
        shell: false,
        windowsHide: true,
        cwd: this.safeCwd,
        env: { ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      this.recordFailure();
      throw processError("spawnCodex", cause);
    }

    const record = this.createRecord(child);
    this.currentRecord = record;
    try {
      await record.spawnPromise;
      if (
        this.currentRecord !== record
        || record.exitObserved
        || record.state !== "starting"
        || record.intentionalTermination
        || record.terminationPromise !== undefined
      ) {
        throw processError("startCodex");
      }
      if (child.stdin === null || child.stdout === null) {
        throw new Error("Codex App Server did not provide stdio pipes");
      }
      record.client = new JsonlRpcClient(
        { input: child.stdin, output: child.stdout },
        {
          requestTimeoutMs: this.requestTimeoutMs,
          onDidTerminate: (error) => this.onClientTerminated(record, error),
        },
      );
      record.state = "running";
      return record.client;
    } catch (cause) {
      const error = cause instanceof CodexError ? cause : processError("startCodex", cause);
      this.recordFailure(record);
      try {
        await this.terminateRecord(record, error, false);
      } catch (terminationError) {
        throw terminationError;
      }
      throw error;
    }
  }

  private onClientTerminated(record: ChildRecord, error: CodexError): void {
    if (
      record.exitObserved
      || record.intentionalTermination
      || record.terminationPromise !== undefined
      || record.childClosed
    ) {
      return;
    }
    if (this.currentRecord === record) {
      this.recordFailure(record);
    }
    void this.terminateRecord(record, error, false).catch(() => undefined);
  }

  private async stopInternal(): Promise<void> {
    const inFlightStart = this.startPromise;
    const record = this.currentRecord;
    try {
      if (record !== undefined) {
        await this.terminateRecord(
          record,
          new CodexError("cancelled", { action: "stopCodex" }),
          true,
        );
      }
    } finally {
      await this.awaitStartCleanup(inFlightStart);
    }
  }

  private async awaitStartCleanup(operation: Promise<JsonlRpcClient> | undefined): Promise<void> {
    if (operation !== undefined) {
      await operation.catch(() => undefined);
    }
  }

  private createRecord(child: ChildProcess): ChildRecord {
    let resolveExit!: () => void;
    let resolveSpawn!: () => void;
    let rejectSpawn!: (reason: unknown) => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const spawnPromise = new Promise<void>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });

    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    let record!: ChildRecord;

    const onSpawn = (): void => {
      if (record.spawnSettled || record.exitObserved) {
        return;
      }
      record.spawnSettled = true;
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onSpawnError);
      child.removeListener("exit", onExitBeforeSpawn);
      record.resolveSpawn();
    };
    const onSpawnError = (cause: Error): void => {
      if (record.spawnSettled) {
        return;
      }
      record.spawnSettled = true;
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onSpawnError);
      child.removeListener("exit", onExitBeforeSpawn);
      record.rejectSpawn(processError("spawnCodex", cause));
    };
    const onExitBeforeSpawn = (): void => {
      if (record.spawnSettled) {
        return;
      }
      record.spawnSettled = true;
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onSpawnError);
      child.removeListener("exit", onExitBeforeSpawn);
      record.rejectSpawn(processError("startCodex"));
    };
    const onExit = (): void => {
      if (record.exitObserved) {
        return;
      }
      record.exitObserved = true;
      record.state = "exited";
      if (!record.spawnSettled) {
        onExitBeforeSpawn();
      }
      this.recordFailure(record);
      record.client?.close(processError("appServerExit"));
      record.resolveExit();
      if (this.currentRecord === record) {
        this.currentRecord = undefined;
      }
      if (record.childClosed) {
        this.removeRecordListeners(record);
      }
    };
    const onError = (cause: Error): void => {
      if (
        record.exitObserved
        || record.intentionalTermination
        || record.terminationPromise !== undefined
        || record.childClosed
      ) {
        return;
      }
      this.recordFailure(record);
      void this.terminateRecord(record, processError("appServerProcess", cause), false)
        .catch(() => undefined);
    };
    const onStdinError = (cause: Error): void => {
      if (
        record.exitObserved
        || record.intentionalTermination
        || record.terminationPromise !== undefined
        || record.childClosed
      ) {
        return;
      }
      this.recordFailure(record);
      void this.terminateRecord(record, processError("appServerStdin", cause), false)
        .catch(() => undefined);
    };
    const onStdoutError = (cause: Error): void => {
      if (
        record.exitObserved
        || record.intentionalTermination
        || record.terminationPromise !== undefined
        || record.childClosed
      ) {
        return;
      }
      this.recordFailure(record);
      void this.terminateRecord(record, processError("appServerStdout", cause), false)
        .catch(() => undefined);
    };
    const onStderr = (chunk: Buffer | string): void => {
      const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      this.logger?.event("appServer.stderr", {
        bytes: value.byteLength,
        lineCount: value.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0).length,
      });
    };
    const onStderrError = (cause: Error): void => {
      if (
        record.exitObserved
        || record.intentionalTermination
        || record.terminationPromise !== undefined
        || record.childClosed
      ) {
        return;
      }
      this.recordFailure(record);
      void this.terminateRecord(record, processError("appServerStderr", cause), false)
        .catch(() => undefined);
    };
    const onChildClose = (): void => {
      record.childClosed = true;
      if (record.exitObserved) {
        this.removeRecordListeners(record);
      }
    };
    const onStdinClose = (): void => {
      record.stdinClosed = true;
      if (record.exitObserved && record.childClosed) {
        this.removeRecordListeners(record);
      }
    };
    const onStdoutClose = (): void => {
      record.stdoutClosed = true;
      if (record.exitObserved && record.childClosed) {
        this.removeRecordListeners(record);
      }
    };
    const onStderrClose = (): void => {
      record.stderrClosed = true;
      if (record.exitObserved && record.childClosed) {
        this.removeRecordListeners(record);
      }
    };

    record = {
      generation,
      child,
      exitPromise,
      resolveExit,
      spawnPromise,
      resolveSpawn,
      rejectSpawn,
      onExit,
      onError,
      onStdinError,
      onStdoutError,
      onStderr,
      onStderrError,
      onSpawn,
      onSpawnError,
      onExitBeforeSpawn,
      onChildClose,
      onStdinClose,
      onStdoutClose,
      onStderrClose,
      spawnSettled: false,
      exitObserved: false,
      childClosed: false,
      stdinClosed: isClosedStream(child.stdin),
      stdoutClosed: isClosedStream(child.stdout),
      stderrClosed: isClosedStream(child.stderr),
      listenersRemoved: false,
      state: "starting",
      intentionalTermination: false,
      failureRecorded: false,
      client: undefined,
      terminationPromise: undefined,
    };

    child.on("spawn", onSpawn);
    child.on("error", onError);
    child.on("error", onSpawnError);
    child.on("exit", onExit);
    child.on("exit", onExitBeforeSpawn);
    child.on("close", onChildClose);
    if (!record.stdinClosed) {
      child.stdin?.on("error", onStdinError);
      child.stdin?.on("close", onStdinClose);
    }
    if (!record.stdoutClosed) {
      child.stdout?.on("error", onStdoutError);
      child.stdout?.on("close", onStdoutClose);
    }
    if (!record.stderrClosed) {
      child.stderr?.on("data", onStderr);
      child.stderr?.on("error", onStderrError);
      child.stderr?.on("close", onStderrClose);
    }
    if (child.pid !== undefined && child.pid !== null) {
      queueMicrotask(onSpawn);
    }
    return record;
  }

  private removeRecordListeners(record: ChildRecord): void {
    if (record.listenersRemoved) {
      return;
    }
    record.listenersRemoved = true;
    const child = record.child;
    child.removeListener("spawn", record.onSpawn);
    child.removeListener("error", record.onError);
    child.removeListener("error", record.onSpawnError);
    child.removeListener("exit", record.onExit);
    child.removeListener("exit", record.onExitBeforeSpawn);
    child.removeListener("close", record.onChildClose);
    child.stdin?.removeListener("error", record.onStdinError);
    child.stdin?.removeListener("close", record.onStdinClose);
    child.stdout?.removeListener("error", record.onStdoutError);
    child.stdout?.removeListener("close", record.onStdoutClose);
    child.stderr?.removeListener("data", record.onStderr);
    child.stderr?.removeListener("error", record.onStderrError);
    child.stderr?.removeListener("close", record.onStderrClose);
  }

  private terminateRecord(
    record: ChildRecord,
    reason: CodexError,
    intentional: boolean,
  ): Promise<void> {
    if (record.terminationPromise !== undefined) {
      return record.terminationPromise;
    }
    record.intentionalTermination ||= intentional;
    record.state = "terminating";
    let resolveTermination!: () => void;
    let rejectTermination!: (reason: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveTermination = resolve;
      rejectTermination = reject;
    });
    record.terminationPromise = operation;
    record.client?.close(reason);
    void this.performTermination(record).then(resolveTermination, rejectTermination);
    return operation;
  }

  private async performTermination(record: ChildRecord): Promise<void> {
    if (record.exitObserved) {
      return;
    }
    const child = record.child;
    try {
      if (child.stdin !== null && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    } catch {
      // The kill escalation remains authoritative.
    }

    if (await this.exitOrTimeout(record.exitPromise, this.killGraceMs)) {
      return;
    }
    this.tryKill(child);
    if (await this.exitOrTimeout(record.exitPromise, this.forceKillWaitMs)) {
      return;
    }
    this.tryKill(child, "SIGKILL");
    if (await this.exitOrTimeout(record.exitPromise, this.forceKillWaitMs)) {
      return;
    }

    record.state = "stuck";
    throw processError("stopCodex");
  }

  private tryKill(child: ChildProcess, signal?: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // Continue to the next bounded escalation step.
    }
  }

  private async exitOrTimeout(exitPromise: Promise<void>, milliseconds: number): Promise<boolean> {
    let timer: SupervisorTimer | undefined;
    let settled = false;
    return new Promise<boolean>((resolve) => {
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          this.clearTimeout(timer);
          timer = undefined;
        }
        resolve(result);
      };
      void exitPromise.then(
        () => finish(true),
        () => finish(false),
      );
      timer = this.setTimeout(() => finish(false), milliseconds);
      const unref = (timer as unknown as { unref?: () => void }).unref;
      unref?.call(timer);
      if (settled) {
        this.clearTimeout(timer);
        timer = undefined;
      }
    });
  }

  private recordFailure(record?: ChildRecord): void {
    if (record?.intentionalTermination || record?.failureRecorded) {
      return;
    }
    if (record !== undefined) {
      record.failureRecorded = true;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 2) {
      this.breakerOpen = true;
    }
  }
}
