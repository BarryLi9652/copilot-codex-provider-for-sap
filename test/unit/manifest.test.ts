import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest contributes two independent Codex providers", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(
    manifest.contributes.languageModelChatProviders.map((entry: { vendor: string }) => entry.vendor),
    ["copilot-codex.chatgpt-oauth", "copilot-codex.local-cli"],
  );
});
