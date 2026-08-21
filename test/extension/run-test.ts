import { spawn } from "node:child_process";
import * as path from "node:path";

import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const VS_CODE_VERSION = "1.131.0";

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "../../..");
  const cachePath = path.join(projectRoot, ".vscode-test");
  const extensionDevelopmentPath = projectRoot;
  const extensionTestsPath = path.resolve(__dirname, "suite/index.js");
  const executable = await downloadAndUnzipVSCode({
    version: VS_CODE_VERSION,
    cachePath,
    extensionDevelopmentPath,
  });
  const args = [
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--extensionTestsPath=${extensionTestsPath}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensions-dir=${path.join(cachePath, "extensions")}`,
    `--user-data-dir=${path.join(cachePath, "user-data")}`,
  ];
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: "inherit",
      env: environment,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`VS Code test host exited with ${signal ?? `code ${code ?? "unknown"}`}`));
    });
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
