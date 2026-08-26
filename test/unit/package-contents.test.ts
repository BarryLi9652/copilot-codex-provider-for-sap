import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listFiles, PackageManager } from "@vscode/vsce";

test("VSIX file discovery excludes local Git worktrees", async () => {
  const files = await listFiles({
    cwd: process.cwd(),
    packageManager: PackageManager.None,
  });

  assert.equal(
    files.some((file) => file.startsWith(".worktrees/")),
    false,
  );
});

test("VSIX file discovery excludes the local deep-code-review draft", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codex-vsix-contents-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  await mkdir(path.join(fixtureRoot, "docs"));
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({
      name: "package-contents-fixture",
      version: "1.0.0",
      engines: { vscode: "^1.125.0" },
    }),
  );
  await writeFile(
    path.join(fixtureRoot, ".vscodeignore"),
    await readFile(path.join(process.cwd(), ".vscodeignore"), "utf8"),
  );
  await writeFile(
    path.join(fixtureRoot, "docs", "2026-08-25-deep-code-review.md"),
    "local review draft",
  );

  const files = await listFiles({
    cwd: fixtureRoot,
    packageManager: PackageManager.None,
  });

  assert.equal(files.includes("docs/2026-08-25-deep-code-review.md"), false);
});

test("extension manifest icon is a packaged 256x256 PNG", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  ) as { icon?: string };

  assert.equal(manifest.icon, "resources/icon.png");

  const files = await listFiles({
    cwd: process.cwd(),
    packageManager: PackageManager.None,
  });
  assert.equal(files.includes("resources/icon.png"), true);

  const icon = await readFile(path.join(process.cwd(), manifest.icon));
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
});
