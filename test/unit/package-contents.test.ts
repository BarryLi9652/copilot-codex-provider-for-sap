import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
