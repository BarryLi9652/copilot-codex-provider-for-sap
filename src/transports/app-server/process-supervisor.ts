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

export interface ProcessSupervisorOptions {
  configuredExecutable?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  fileSystem?: ExecutableFileSystem;
  requestTimeoutMs?: number;
  killGraceMs?: number;
  logger?: SafeLogger;
  spawnProcess?: SpawnProcess;
}

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
const DEFAULT_KILL_GRACE_MS = 5_000;

export class ProcessSupervisor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly safeCwd: string;
  private readonly killGraceMs: number;
  private readonly logger: SafeLogger | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly locator: ExecutableLocator;
  private readonly spawnProcess: SpawnProcess;
  private child: ChildProcess | undefined;
  private client: JsonlRpcClient | undefined;
  private startPromise: Promise<JsonlRpcClient> | undefined;
  private stopPromise: Promise<void> | undefined;
  private exitPromise: Promise<void> | undefined;
  private resolveExit: (() => void) | undefined;
  private stopping = false;
  private consecutiveFailures = 0;
  private breakerOpen = false;

  public constructor(options: ProcessSupervisorOptions = {}) {
    this.env = options.env ?? { ...process.env };
    this.safeCwd = path.resolve(options.cwd ?? process.cwd());
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    if (!Number.isFinite(this.killGraceMs) || this.killGraceMs <= 0) {
      throw new RangeError("killGraceMs must be positive");
    }
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

  public async start(): Promise<JsonlRpcClient> {
    if (this.breakerOpen) {
      throw processError("startCodex");
    }
    if (this.client !== undefined && !this.client.isClosed && this.child !== undefined) {
      return this.client;
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    const pending = this.startInternal();
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) {
        this.startPromise = undefined;
      }
    }
  }

  public async restart(): Promise<JsonlRpcClient> {
    this.breakerOpen = false;
    this.consecutiveFailures = 0;
    await this.stop();
    return this.start();
  }

  public async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    const pending = this.stopInternal();
    this.stopPromise = pending;
    try {
      await pending;
    } finally {
      if (this.stopPromise === pending) {
        this.stopPromise = undefined;
      }
    }
  }

  private async startInternal(): Promise<JsonlRpcClient> {
    if (this.breakerOpen) {
      throw processError("startCodex");
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

    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    child.once("exit", this.handleExit);
    child.once("error", this.handleChildError);
    child.stderr?.on("data", this.handleStderr);

    try {
      await this.waitForSpawn(child);
      if (child.stdin === null || child.stdout === null) {
        throw new Error("Codex App Server did not provide stdio pipes");
      }
      const client = new JsonlRpcClient(
        { input: child.stdin, output: child.stdout },
        { requestTimeoutMs: this.requestTimeoutMs },
      );
      this.client = client;
      return client;
    } catch (cause) {
      this.cleanupFailedChild(child);
      this.recordFailure();
      if (cause instanceof CodexError) {
        throw cause;
      }
      throw processError("startCodex", cause);
    }
  }

  private async stopInternal(): Promise<void> {
    const child = this.child;
    const exitPromise = this.exitPromise;
    if (child === undefined || exitPromise === undefined) {
      return;
    }

    this.stopping = true;
    this.client?.close(new CodexError("cancelled", { action: "stopCodex" }));
    if (child.stdin !== null && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }

    await Promise.race([exitPromise, delay(this.killGraceMs)]);
    if (this.child === child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // The exit handler remains responsible for resolving the lifecycle promise.
      }
      await exitPromise;
    }
    this.stopping = false;
  }

  private readonly handleExit = (): void => {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    this.client?.close(processError("appServerExit"));
    this.client = undefined;
    this.child = undefined;
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.exitPromise = undefined;
    if (!this.stopping) {
      this.recordFailure();
    }
  };

  private readonly handleChildError = (cause: Error): void => {
    if (this.stopping) {
      return;
    }
    this.client?.close(processError("appServerProcess", cause));
  };

  private readonly handleStderr = (chunk: Buffer | string): void => {
    const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.logger?.event("appServer.stderr", {
      bytes: value.byteLength,
      lineCount: value.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0).length,
    });
  };

  private async waitForSpawn(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.removeListener("error", onError);
        resolve();
      };
      const onError = (cause: Error): void => {
        child.removeListener("spawn", onSpawn);
        reject(cause);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      if (child.pid !== undefined && child.pid !== null) {
        queueMicrotask(onSpawn);
      }
    });
  }

  private cleanupFailedChild(child: ChildProcess): void {
    if (this.child !== child) {
      return;
    }
    child.removeListener("exit", this.handleExit);
    child.removeListener("error", this.handleChildError);
    child.stderr?.removeListener("data", this.handleStderr);
    if (child.stdin !== null && !child.stdin.destroyed) {
      child.stdin.destroy();
    }
    if (child.stdout !== null && !child.stdout.destroyed) {
      child.stdout.destroy();
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // A spawn failure can already have torn the process down.
      }
    }
    this.child = undefined;
    this.client = undefined;
    this.resolveExit?.();
    this.resolveExit = undefined;
    this.exitPromise = undefined;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 2) {
      this.breakerOpen = true;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
