import assert from "node:assert/strict";
import test from "node:test";

import { CodexError } from "../../src/core/errors.js";
import type {
  CodexModel,
  CodexRequest,
  TransportEvent,
} from "../../src/core/types.js";
import {
  AppServerTransport,
  type AppServerDynamicTool,
  type AppServerSecurityFailure,
  type AppServerTransportLease,
  type AppServerTransportSession,
  type AppServerTurnStartParams,
} from "../../src/transports/app-server/app-server-transport.js";
import type {
  Disposable,
  JsonRpcId,
  JsonRpcServerNotificationHandler,
  JsonRpcServerRequestHandler,
} from "../../src/transports/app-server/protocol.js";
import { ToolContinuationRegistry } from "../../src/transports/app-server/tool-continuations.js";

const model: CodexModel = {
  id: "gpt-required-test",
  name: "GPT Required Test",
  family: "gpt",
  version: "1",
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  capabilities: {
    imageInput: false,
    toolCalling: true,
    parallelToolCalls: false,
  },
};

const tool: AppServerDynamicTool = {
  type: "function",
  name: "lookup_a",
  description: "Look up A.",
  inputSchema: { type: "object" },
  deferLoading: false,
};

const request = (toolMode: CodexRequest["toolMode"], tools = [tool]): CodexRequest => ({
  requestId: `request-${toolMode}`,
  modelId: model.id,
  messages: [{ role: "user", parts: [{ kind: "text", text: "Use the available context." }] }],
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  toolMode,
  instructions: "base instructions",
});

type TurnMode = "complete" | "tool";

class RequiredToolLease implements AppServerTransportLease {
  public readonly generation = 1;
  public readonly leaseId = "required-tool-lease";
  public readonly capabilities = { dynamicTools: true };
  public readonly turnInputs: AppServerTurnStartParams[] = [];
  public readonly pendingToolCalls: Promise<unknown>[] = [];

  private readonly notificationHandlers = new Map<string, JsonRpcServerNotificationHandler>();
  private toolHandler: JsonRpcServerRequestHandler | undefined;

  public constructor(private readonly mode: TurnMode) {}

  public startThread(
    _dynamicTools: readonly AppServerDynamicTool[],
    _signal: AbortSignal,
  ): Promise<{ threadId: string }> {
    return Promise.resolve({ threadId: "thread-required" });
  }

  public startTurn(
    params: AppServerTurnStartParams,
    _signal: AbortSignal,
  ): Promise<{ turnId: string }> {
    this.turnInputs.push(params);
    queueMicrotask(() => {
      if (this.mode === "tool") {
        const pending = this.toolHandler?.({
          threadId: "thread-required",
          turnId: "turn-required",
          callId: "call-required",
          name: "lookup_a",
          input: { key: "a" },
        }, 1);
        if (pending !== undefined) {
          this.pendingToolCalls.push(Promise.resolve(pending));
        }
        return;
      }
      void this.notificationHandlers.get("turn/completed")?.({
        threadId: "thread-required",
        turn: {
          id: "turn-required",
          status: "completed",
          items: [],
          error: null,
        },
      });
    });
    return Promise.resolve({ turnId: "turn-required" });
  }

  public interrupt(_threadId: string, _turnId: string): Promise<void> {
    return Promise.resolve();
  }

  public unsubscribe(_threadId: string): Promise<void> {
    return Promise.resolve();
  }

  public onNotification(
    method: string,
    handler: JsonRpcServerNotificationHandler,
  ): Disposable {
    this.notificationHandlers.set(method, handler);
    return { dispose: () => this.notificationHandlers.delete(method) };
  }

  public onToolCall(handler: JsonRpcServerRequestHandler): Disposable {
    this.toolHandler = handler;
    return {
      dispose: () => {
        if (this.toolHandler === handler) {
          this.toolHandler = undefined;
        }
      },
    };
  }

  public onSecurityFailure(_handler: (failure: AppServerSecurityFailure) => void): Disposable {
    return { dispose: () => undefined };
  }

  public onProcessExit(_handler: (error: CodexError) => void): Disposable {
    return { dispose: () => undefined };
  }

  public release(): void {}
}

class RequiredToolSession implements AppServerTransportSession {
  public readonly lease: RequiredToolLease;

  public constructor(mode: TurnMode) {
    this.lease = new RequiredToolLease(mode);
  }

  public listModels(): Promise<readonly CodexModel[]> {
    return Promise.resolve([model]);
  }

  public acquireTransportLease(): Promise<AppServerTransportLease> {
    return Promise.resolve(this.lease);
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function collect(iterable: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const events: TransportEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

interface LoggedEvent {
  readonly name: string;
  readonly metadata: Record<string, unknown>;
}

const recordingLogger = (events: LoggedEvent[]) => ({
  event: (name: string, metadata: Record<string, unknown> = {}): void => {
    events.push({ name, metadata });
  },
});

const firstTurnText = (session: RequiredToolSession): string => {
  const input = session.lease.turnInputs[0]?.input[0];
  return input?.type === "text" ? input.text : "";
};

test("rejects a required turn that completes without a supplied dynamic tool call", async () => {
  const session = new RequiredToolSession("complete");
  const logged: LoggedEvent[] = [];
  const transport = new AppServerTransport(
    session,
    new ToolContinuationRegistry(),
    { logger: recordingLogger(logged) },
  );

  try {
    await assert.rejects(
      collect(transport.generate(request("required"), new AbortController().signal)),
      (error: unknown) => error instanceof CodexError
        && String(error.code) === "requiredToolMissing"
        && error.action === "showDiagnostics",
    );
    assert.match(
      firstTurnText(session),
      /requires at least one supplied dynamic tool call/i,
    );
    assert.deepEqual(
      logged.find(({ name }) => name === "appServer.requiredTool.missing"),
      { name: "appServer.requiredTool.missing", metadata: { toolMode: "required" } },
    );
  } finally {
    await transport.dispose();
  }
});

test("surfaces any supplied dynamic tool call for a required turn", async () => {
  const session = new RequiredToolSession("tool");
  const logged: LoggedEvent[] = [];
  const transport = new AppServerTransport(
    session,
    new ToolContinuationRegistry(),
    { logger: recordingLogger(logged) },
  );

  try {
    assert.deepEqual(
      await collect(transport.generate(request("required"), new AbortController().signal)),
      [{
        type: "tool-call",
        callId: "call-required",
        name: "lookup_a",
        input: { key: "a" },
      }],
    );
  } finally {
    await transport.dispose();
    await Promise.allSettled(session.lease.pendingToolCalls);
  }
  assert.deepEqual(
    logged.find(({ name }) => name === "appServer.tool.pendingResultTerminated"),
    {
      name: "appServer.tool.pendingResultTerminated",
      metadata: { reason: "cancelled", pendingCount: 1 },
    },
  );
});

test("allows an automatic turn to complete without a tool call", async () => {
  const session = new RequiredToolSession("complete");
  const transport = new AppServerTransport(session);

  try {
    assert.deepEqual(
      await collect(transport.generate(request("auto", []), new AbortController().signal)),
      [{ type: "completed" }],
    );
    assert.doesNotMatch(
      firstTurnText(session),
      /requires at least one supplied dynamic tool call/i,
    );
  } finally {
    await transport.dispose();
  }
});
