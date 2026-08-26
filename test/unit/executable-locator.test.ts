import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import { ExecutableLocator } from "../../src/transports/app-server/executable-locator.js";

interface FakeStats {
  isFile(): boolean;
  isDirectory(): boolean;
}

class FakeFileSystem {
  public readonly files = new Set<string>();
  public readonly directories = new Set<string>();

  public statSync(candidate: string): FakeStats {
    if (this.files.has(candidate)) {
      return { isFile: () => true, isDirectory: () => false };
    }
    if (this.directories.has(candidate)) {
      return { isFile: () => false, isDirectory: () => true };
    }
    throw new Error("missing");
  }
}

test("prefers a configured absolute executable over PATH and the Windows alias", () => {
  const fs = new FakeFileSystem();
  const configured = path.win32.normalize("C:\\Tools\\codex.exe");
  const pathCandidate = path.win32.normalize("C:\\First\\codex.exe");
  const alias = path.win32.join("C:\\Users\\tester\\AppData\\Local", "Microsoft", "WindowsApps", "codex.exe");
  fs.files.add(configured);
  fs.files.add(pathCandidate);
  fs.files.add(alias);

  const locator = new ExecutableLocator({
    configuredExecutable: configured,
    env: {
      PATH: ["C:\\First", "C:\\Second"].join(path.delimiter),
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    },
    platform: "win32",
    fileSystem: fs,
  });

  assert.equal(locator.resolve(), configured);
});

test("searches PATH entries in order before the Windows app execution alias", () => {
  const fs = new FakeFileSystem();
  const first = path.win32.normalize("C:\\First\\codex.exe");
  const second = path.win32.normalize("C:\\Second\\codex.exe");
  const alias = path.win32.join("C:\\Users\\tester\\AppData\\Local", "Microsoft", "WindowsApps", "codex.exe");
  fs.files.add(second);
  fs.files.add(alias);

  const locator = new ExecutableLocator({
    env: {
      PATH: ["C:\\First", "C:\\Second"].join(path.delimiter),
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    },
    platform: "win32",
    fileSystem: fs,
  });

  assert.equal(locator.resolve(), second);
  fs.files.delete(second);
  assert.equal(locator.resolve(), alias);
});

test("automatic Windows discovery ignores extensionless codex executables", () => {
  const fs = new FakeFileSystem();
  const extensionless = path.win32.normalize("C:\\Tools\\codex");
  fs.files.add(extensionless);
  const locator = new ExecutableLocator({
    env: { PATH: "C:\\Tools" },
    platform: "win32",
    fileSystem: fs,
  });

  assert.throws(
    () => locator.resolve(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
});

test("explicit absolute Windows extensionless executables remain supported", () => {
  const fs = new FakeFileSystem();
  const configured = path.win32.normalize("C:\\Tools\\codex");
  fs.files.add(configured);
  const locator = new ExecutableLocator({
    configuredExecutable: configured,
    env: {},
    platform: "win32",
    fileSystem: fs,
  });

  assert.equal(locator.resolve(), configured);
});

test("rejects relative configured executables and configured directories", () => {
  const relative = new ExecutableLocator({
    configuredExecutable: "codex.exe",
    env: {},
    platform: "win32",
    fileSystem: new FakeFileSystem(),
  });
  assert.throws(
    () => relative.resolve(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );

  const fs = new FakeFileSystem();
  const directory = path.win32.normalize("C:\\Tools\\codex.exe");
  fs.directories.add(directory);
  const configuredDirectory = new ExecutableLocator({
    configuredExecutable: directory,
    env: {},
    platform: "win32",
    fileSystem: fs,
  });
  assert.throws(
    () => configuredDirectory.resolve(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
});

test("reports a process error when no usable candidate exists", () => {
  const locator = new ExecutableLocator({
    env: { PATH: "C:\\Missing" },
    platform: "win32",
    fileSystem: new FakeFileSystem(),
  });
  assert.throws(
    () => locator.resolve(),
    (error: unknown) => error instanceof CodexError && error.code === "process",
  );
});

test("splits PATH using the injected Windows delimiter instead of the host delimiter", () => {
  const fs = new FakeFileSystem();
  const expected = path.win32.normalize("C:\\Second\\codex.exe");
  fs.files.add(expected);
  const locator = new ExecutableLocator({
    env: { PATH: "C:\\First;C:\\Second" },
    platform: "win32",
    fileSystem: fs,
  });

  assert.equal(locator.resolve(), expected);
});

test("splits PATH using the injected POSIX delimiter when simulating a non-Windows host", () => {
  const fs = new FakeFileSystem();
  const expected = "/second/codex";
  fs.files.add(expected);
  const locator = new ExecutableLocator({
    env: { PATH: "/first:/second" },
    platform: "linux",
    fileSystem: fs,
  });

  assert.equal(locator.resolve(), expected);
});
