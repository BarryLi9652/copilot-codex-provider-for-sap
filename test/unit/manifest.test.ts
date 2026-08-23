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

test("manifest contributes model-default ChatGPT reasoning and speed overrides", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const properties = manifest.contributes.configuration.properties;

  assert.deepEqual(properties["copilotCodex.chatgpt.reasoningEffort"], {
    type: "string",
    enum: ["modelDefault", "none", "low", "medium", "high", "xhigh", "max"],
    enumDescriptions: [
      "Use the selected model's default reasoning effort.",
      "Disable reasoning when the selected model supports it.",
      "Favor lower latency and lighter reasoning.",
      "Balance reasoning depth and latency.",
      "Use deeper reasoning for difficult tasks.",
      "Use extra-high reasoning for very difficult tasks.",
      "Use maximum reasoning for the hardest quality-first tasks.",
    ],
    default: "modelDefault",
    description: "ChatGPT OAuth reasoning effort. Applied to new requests without reloading VS Code.",
  });
  assert.deepEqual(properties["copilotCodex.chatgpt.speedMode"], {
    type: "string",
    enum: ["modelDefault", "fast"],
    enumDescriptions: [
      "Use the ChatGPT backend's default service tier.",
      "Request Fast service when the account and selected model support it.",
    ],
    default: "modelDefault",
    description: "ChatGPT OAuth response speed. Applied to new requests without reloading VS Code.",
  });
});

test("manifest exposes one Codex Copilot Manager command", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(manifest.contributes.commands, [{
    command: "copilotCodex.manager",
    title: "Codex Copilot Manager",
  }]);
});

test("release metadata names the 0.1.7 VSIX consistently", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.equal(manifest.version, "0.1.7");
  assert.equal(lockfile.version, "0.1.7");
  assert.equal(lockfile.packages[""].version, "0.1.7");
  assert.match(
    manifest.scripts["package:vsix"],
    /dist\/copilot-codex-provider-for-sap-0\.1\.7\.vsix$/,
  );
});

test("release metadata resolves packaged README assets through GitHub", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/LeON-W666/copilot-codex-provider-for-sap.git",
  });
});
