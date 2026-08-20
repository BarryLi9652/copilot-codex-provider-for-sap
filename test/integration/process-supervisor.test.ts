import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
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
