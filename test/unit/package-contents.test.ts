import assert from "node:assert/strict";
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
