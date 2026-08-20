import readline from "node:readline";

const crashAfterInit = process.env.FAKE_APP_SERVER_CRASH_AFTER_INIT === "1";
const noDynamicTools = process.env.FAKE_APP_SERVER_NO_DYNAMIC_TOOLS === "1";

let threadNumber = 0;
let turnNumber = 0;
let initialized = false;

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const sendError = (id, code, message) => {
  send({ id, error: { code, message } });
};

const handle = (message) => {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }

  const { id, method, params } = message;
  if (typeof method !== "string") {
    return;
  }

  if (id === undefined) {
    return;
  }

  switch (method) {
    case "initialize":
      initialized = true;
      send({
        id,
        result: {
          protocolVersion: "1",
          serverInfo: { name: "fake-app-server", version: "1.0.0" },
          capabilities: { experimentalApi: true, dynamicTools: !noDynamicTools },
        },
      });
      if (crashAfterInit) {
        setImmediate(() => process.exit(17));
      }
      return;

    case "account/read":
      send({ id, result: { account: { type: "chatgpt", planType: "plus" } } });
      return;

    case "model/list":
      send({
        id,
        result: {
          models: [
            {
              id: "fake-codex",
              displayName: "Fake Codex",
              description: "Deterministic fake App Server model",
              inputTokenLimit: 16_000,
              outputTokenLimit: 4_000,
              inputModalities: ["text", "image"],
              supportsTools: true,
            },
          ],
        },
      });
      return;

    case "thread/start":
      if (noDynamicTools && params && typeof params === "object" && "dynamicTools" in params) {
        sendError(id, -32602, "dynamicTools is unavailable");
        return;
      }
      threadNumber += 1;
      send({ id, result: { thread: { id: `fake-thread-${threadNumber}` } } });
      return;

    case "turn/start":
      turnNumber += 1;
      send({ id, result: { turn: { id: `fake-turn-${turnNumber}` }, status: "started" } });
      return;

    case "turn/interrupt":
      send({ id, result: { interrupted: true } });
      return;

    case "item/tool/call":
      send({
        id,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: "fake tool result" }],
        },
      });
      return;

    default:
      sendError(id, -32601, "method not found");
  }
};

if (process.env.FAKE_APP_SERVER_STDERR !== undefined) {
  process.stderr.write(process.env.FAKE_APP_SERVER_STDERR);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  try {
    handle(JSON.parse(line));
  } catch {
    process.stderr.write("fake server received malformed JSON\n");
  }
});
input.on("close", () => {
  if (initialized || process.stdin.readableEnded) {
    process.exit(0);
  }
});
