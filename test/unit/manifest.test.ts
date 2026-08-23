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

test("manifest contributes a ChatGPT-only proxy setting", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(
    manifest.contributes.configuration.properties["copilotCodex.chatgpt.proxyUrl"],
    {
      type: "string",
      default: "",
      pattern: "^$|^https?://",
      description: "Optional HTTP(S) proxy used only for ChatGPT OAuth, model discovery, and responses. Reload VS Code after changing it.",
    },
  );
});
