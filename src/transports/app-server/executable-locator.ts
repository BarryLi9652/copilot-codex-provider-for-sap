import fs from "node:fs";
import path from "node:path";

import { CodexError } from "../../core/errors.js";

export interface ExecutableFileSystem {
  statSync(candidate: string): { isFile(): boolean; isDirectory(): boolean };
}

export interface ExecutableLocatorOptions {
  configuredExecutable?: string;
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  platform?: NodeJS.Platform;
  fileSystem?: ExecutableFileSystem;
}

const isAbsolute = (candidate: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);

const join = (directory: string, filename: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.win32.join(directory, filename) : path.posix.join(directory, filename);

const candidateNames = (platform: NodeJS.Platform): readonly string[] =>
  platform === "win32" ? ["codex.exe"] : ["codex"];

const pathDelimiter = (platform: NodeJS.Platform): string =>
  platform === "win32" ? ";" : ":";

export class ExecutableLocator {
  private readonly configuredExecutable: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pathValue: string;
  private readonly platform: NodeJS.Platform;
  private readonly fileSystem: ExecutableFileSystem;

  public constructor(options: ExecutableLocatorOptions = {}) {
    this.configuredExecutable = options.configuredExecutable?.trim() || undefined;
    this.env = options.env ?? process.env;
    this.pathValue = options.pathValue ?? this.env.PATH ?? "";
    this.platform = options.platform ?? process.platform;
    this.fileSystem = options.fileSystem ?? fs;
  }

  public resolve(): string {
    if (this.configuredExecutable !== undefined) {
      if (!isAbsolute(this.configuredExecutable, this.platform)) {
        throw unavailable("configured Codex executable must be absolute");
      }
      if (!this.isUsableFile(this.configuredExecutable)) {
        throw unavailable("configured Codex executable is not a file");
      }
      return this.configuredExecutable;
    }

    for (const directory of this.pathValue.split(pathDelimiter(this.platform))) {
      if (directory.trim() === "") {
        continue;
      }
      for (const name of candidateNames(this.platform)) {
        const candidate = join(directory, name, this.platform);
        if (this.isUsableFile(candidate)) {
          return candidate;
        }
      }
    }

    if (this.platform === "win32" && this.env.LOCALAPPDATA !== undefined) {
      const alias = path.win32.join(
        this.env.LOCALAPPDATA,
        "Microsoft",
        "WindowsApps",
        "codex.exe",
      );
      if (isAbsolute(alias, this.platform) && this.isUsableFile(alias)) {
        return alias;
      }
    }

    throw unavailable("Codex executable was not found");
  }

  private isUsableFile(candidate: string): boolean {
    try {
      const stats = this.fileSystem.statSync(candidate);
      return stats.isFile() && !stats.isDirectory();
    } catch {
      return false;
    }
  }
}

export function locateCodexExecutable(options: ExecutableLocatorOptions = {}): string {
  return new ExecutableLocator(options).resolve();
}

function unavailable(reason: string): CodexError {
  return new CodexError("process", { action: "selectCodex", cause: new Error(reason) });
}
