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
  JsonRpcServerNotificationHandler,
  JsonRpcServerRequestHandler,
} from "../../src/transports/app-server/protocol.js";
import { ToolContinuationRegistry } from "../../src/transports/app-server/tool-continuations.js";

const model: CodexModel = {
  id: "gpt-write-continuation",
  name: "GPT Write Continuation",
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

const suppliedTools = [
  {
    name: "get_abap_object_workspace_uri",
    description: "Resolve an ABAP workspace URI.",
    inputSchema: { type: "object", properties: { objectName: { type: "string" } } },
  },
  {
    name: "replace_string_in_file",
    description: "Replace text in a VS Code virtual-workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["uri", "oldString", "newString"],
    },
  },
  {
    name: "get_abap_diagnostics",
    description: "Read ABAP diagnostics.",
    inputSchema: { type: "object" },
  },
] as const;

class WriteContinuationLease implements AppServerTransportLease {
  public readonly generation = 1;
  public readonly leaseId = "write-continuation-lease";
  public readonly capabilities = { dynamicTools: true };
  public readonly startedWith: AppServerDynamicTool[][] = [];
  public startTurnCount = 0;
  public pendingToolCall: Promise<unknown> | undefined;

  private readonly notifications = new Map<string, JsonRpcServerNotificationHandler>();
  private toolHandler: JsonRpcServerRequestHandler | undefined;

  public startThread(
    dynamicTools: readonly AppServerDynamicTool[],
    _signal: AbortSignal,
  ): Promise<{ threadId: string }> {
    this.startedWith.push([...dynamicTools]);
    return Promise.resolve({ threadId: "thread-write" });
  }

  public startTurn(
    _params: AppServerTurnStartParams,
    _signal: AbortSignal,
  ): Promise<{ turnId: string }> {
    this.startTurnCount += 1;
    queueMicrotask(() => {
      const pending = this.toolHandler?.({
        threadId: "thread-write",
        turnId: "turn-write",
        callId: "write-call-1",
        name: "replace_string_in_file",
        input: {
          uri: "adt://DEV/src/zcl_demo.clas.abap",
          oldString: "METHOD old.",
          newString: "METHOD new.",
        },
      }, 1);
      if (pending === undefined) {
        return;
      }
      this.pendingToolCall = Promise.resolve(pending);
      void this.pendingToolCall.then(() => {
        void this.notifications.get("item/agentMessage/delta")?.({
          threadId: "thread-write",
          turnId: "turn-write",
          delta: "ABAP change completed.",
        });
        void this.notifications.get("turn/completed")?.({
          threadId: "thread-write",
          turnId: "turn-write",
          status: "completed",
        });
      });
    });
    return Promise.resolve({ turnId: "turn-write" });
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
    this.notifications.set(method, handler);
    return { dispose: () => this.notifications.delete(method) };
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

class WriteContinuationSession implements AppServerTransportSession {
  public readonly lease = new WriteContinuationLease();

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

const request = (messages: CodexRequest["messages"], requestId: string): CodexRequest => ({
  requestId,
  modelId: model.id,
  messages,
  tools: suppliedTools,
  toolMode: "required",
  instructions: "SAP write instructions",
});

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

test("surfaces a supplied ABAP edit tool and resumes the original App Server turn", async () => {
  const session = new WriteContinuationSession();
  const registry = new ToolContinuationRegistry({ now: () => 500 });
  const logged: LoggedEvent[] = [];
  const logger = {
    event: (name: string, metadata: Record<string, unknown> = {}): void => {
      logged.push({ name, metadata });
    },
  };
  const transport = new AppServerTransport(session, registry, { logger } as never);

  try {
    assert.deepEqual(
      await collect(transport.generate(request([{
        role: "user",
        parts: [{ kind: "text", text: "Rename the method in the existing ABAP object." }],
      }], "request-write-1"), new AbortController().signal)),
      [{
        type: "tool-call",
        callId: "write-call-1",
        name: "replace_string_in_file",
        input: {
          uri: "adt://DEV/src/zcl_demo.clas.abap",
          oldString: "METHOD old.",
          newString: "METHOD new.",
        },
      }],
    );

    assert.deepEqual(session.lease.startedWith[0], suppliedTools.map((tool) => ({
      type: "function",
      ...tool,
      deferLoading: false,
    })));

    assert.deepEqual(
      await collect(transport.generate(request([{
        role: "user",
        parts: [{
          kind: "tool-result",
          callId: "write-call-1",
          content: [{ kind: "text", text: "Edit applied by VS Code." }],
        }],
      }], "request-write-2"), new AbortController().signal)),
      [
        { type: "text-delta", text: "ABAP change completed." },
        { type: "completed" },
      ],
    );

    assert.equal(session.lease.startTurnCount, 1);
    assert.equal(registry.size, 0);
    await session.lease.pendingToolCall;

    assert.deepEqual(logged[0], {
      name: "appServer.request.tools",
      metadata: {
        toolMode: "required",
        toolCount: 3,
        hasAbapRead: false,
        hasWorkspaceUriResolver: true,
        hasCreate: false,
        hasGenericEdit: true,
        hasAbapSemanticEdit: false,
        hasDiagnostics: true,
        hasActivate: false,
      },
    });
    assert.deepEqual(
      logged
        .map(({ name }) => name)
        .filter((name) => name.startsWith("appServer.tool.")),
      [
        "appServer.tool.requested",
        "appServer.tool.surfaced",
        "appServer.tool.resultReceived",
        "appServer.tool.resumed",
      ],
    );
    for (const event of logged.slice(1)) {
      assert.deepEqual(event.metadata, { toolName: "replace_string_in_file" });
    }

    const serializedLogs = JSON.stringify(logged);
    assert.doesNotMatch(serializedLogs, /adt:\/\/DEV/);
    assert.doesNotMatch(serializedLogs, /METHOD old|METHOD new/);
    assert.doesNotMatch(serializedLogs, /Edit applied by VS Code/);
    assert.doesNotMatch(serializedLogs, /Rename the method/);
  } finally {
    await transport.dispose();
  }
});
