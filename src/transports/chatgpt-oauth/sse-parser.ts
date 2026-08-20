import type { TransportEvent } from "../../core/types.js";

export interface ResponsesSseLogger {
  event(name: string, metadata?: Record<string, unknown>): void;
}

interface FunctionCallState {
  itemId?: string;
  callId?: string;
  name?: string;
  argumentsText: string;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const findFrameEnd = (value: string): { end: number; delimiterLength: number } | undefined => {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n" && value[index + 1] === "\n") {
      return { end: index, delimiterLength: 2 };
    }

    if (value[index] === "\r" && value[index + 1] === "\r") {
      return { end: index, delimiterLength: 2 };
    }

    if (
      value[index] === "\r" &&
      value[index + 1] === "\n" &&
      value[index + 2] === "\r" &&
      value[index + 3] === "\n"
    ) {
      return { end: index, delimiterLength: 4 };
    }
  }

  return undefined;
};

const parseFrame = (frame: string): { eventName?: string; data?: string } => {
  const eventData: string[] = [];
  let eventName: string | undefined;
  const lines = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      eventData.push(value);
    }
  }

  return {
    ...(eventName === undefined ? {} : { eventName }),
    ...(eventData.length === 0 ? {} : { data: eventData.join("\n") }),
  };
};

const findUsage = (payload: JsonRecord): JsonRecord | undefined => {
  const response = isRecord(payload.response) ? payload.response : undefined;
  return isRecord(response?.usage)
    ? response.usage
    : isRecord(payload.usage)
      ? payload.usage
      : undefined;
};

export class ResponsesSseParser {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private completed = false;
  private readonly functionCalls = new Map<string, FunctionCallState>();

  public constructor(private readonly logger?: ResponsesSseLogger) {}

  public push(chunk: Uint8Array | string): readonly TransportEvent[] {
    this.pending += typeof chunk === "string"
      ? chunk
      : this.decoder.decode(chunk, { stream: true });

    const events: TransportEvent[] = [];
    while (true) {
      const frame = findFrameEnd(this.pending);
      if (frame === undefined) {
        break;
      }

      const content = this.pending.slice(0, frame.end);
      this.pending = this.pending.slice(frame.end + frame.delimiterLength);
      events.push(...this.parseFrame(content));
    }

    return events;
  }

  private parseFrame(frame: string): readonly TransportEvent[] {
    const parsed = parseFrame(frame);
    if (parsed.data?.trim() === "[DONE]") {
      return this.emitCompleted();
    }

    let payload: unknown;
    if (parsed.data !== undefined && parsed.data.length > 0) {
      try {
        payload = JSON.parse(parsed.data) as unknown;
      } catch {
        this.report("chatgpt.sse.malformed_event", parsed.eventName);
        return [];
      }
    }

    const eventName = parsed.eventName ?? (isRecord(payload) ? stringValue(payload.type) : undefined);
    if (eventName === undefined) {
      this.report("chatgpt.sse.unknown_event", undefined);
      return [];
    }

    if (eventName === "response.output_text.delta") {
      if (!isRecord(payload) || typeof payload.delta !== "string") {
        this.report("chatgpt.sse.malformed_event", eventName);
        return [];
      }

      return payload.delta.length === 0 ? [] : [{ type: "text-delta", text: payload.delta }];
    }

    if (eventName === "response.function_call_arguments.delta") {
      this.captureArgumentsDelta(payload, eventName);
      return [];
    }

    if (eventName === "response.function_call_arguments.done") {
      return this.emitFunctionCallFromPayload(payload, eventName);
    }

    if (eventName === "response.output_item.done") {
      return this.emitOutputItem(payload, eventName);
    }

    if (eventName === "response.completed") {
      const events: TransportEvent[] = [];
      if (isRecord(payload)) {
        const usage = findUsage(payload);
        if (usage !== undefined) {
          const inputTokens = numberValue(usage.input_tokens);
          const outputTokens = numberValue(usage.output_tokens);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            events.push({
              type: "usage",
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
            });
          }
        }
      }

      events.push(...this.emitCompleted());
      return events;
    }

    if (eventName === "error" || eventName === "response.failed") {
      this.report("chatgpt.sse.remote_failure", eventName);
      return [];
    }

    this.report("chatgpt.sse.unknown_event", eventName);
    return [];
  }

  private captureArgumentsDelta(payload: unknown, eventName: string): void {
    if (!isRecord(payload) || typeof payload.delta !== "string") {
      this.report("chatgpt.sse.malformed_event", eventName);
      return;
    }

    const itemId = stringValue(payload.item_id);
    const callId = stringValue(payload.call_id);
    const key = callId ?? itemId;
    if (key === undefined) {
      this.report("chatgpt.sse.malformed_event", eventName);
      return;
    }

    const existing = this.findFunctionCall(itemId, callId);
    const state = existing?.state ?? {
      ...(itemId === undefined ? {} : { itemId }),
      ...(callId === undefined ? {} : { callId }),
      argumentsText: "",
    };
    state.itemId = itemId ?? state.itemId;
    state.callId = callId ?? state.callId;
    state.name = stringValue(payload.name) ?? state.name;
    state.argumentsText += payload.delta;

    if (existing !== undefined && existing.key !== key) {
      this.functionCalls.delete(existing.key);
    }
    this.functionCalls.set(key, state);
  }

  private emitFunctionCallFromPayload(payload: unknown, eventName: string): readonly TransportEvent[] {
    if (!isRecord(payload)) {
      this.report("chatgpt.sse.malformed_event", eventName);
      return [];
    }

    const rawItemId = stringValue(payload.item_id);
    const rawCallId = stringValue(payload.call_id);
    const existing = this.findFunctionCall(rawItemId, rawCallId);
    const itemId = rawItemId ?? existing?.state.itemId;
    const callId = rawCallId ?? existing?.state.callId;
    const argumentsValue = typeof payload.arguments === "string"
      ? payload.arguments
      : existing?.state.argumentsText;
    return this.emitFunctionCall(
      {
        itemId,
        callId,
        name: stringValue(payload.name) ?? existing?.state.name,
        argumentsText: argumentsValue,
      },
      eventName,
    );
  }

  private emitOutputItem(payload: unknown, eventName: string): readonly TransportEvent[] {
    if (!isRecord(payload) || !isRecord(payload.item)) {
      this.report("chatgpt.sse.malformed_event", eventName);
      return [];
    }

    const item = payload.item;
    if (item.type !== "function_call") {
      return [];
    }

    const rawItemId = stringValue(item.id);
    const rawCallId = stringValue(item.call_id);
    const existing = this.findFunctionCall(rawItemId, rawCallId);
    const itemId = rawItemId ?? existing?.state.itemId;
    const callId = rawCallId ?? existing?.state.callId;
    const argumentsText = typeof item.arguments === "string"
      ? item.arguments
      : existing?.state.argumentsText;

    return this.emitFunctionCall(
      {
        itemId,
        callId,
        name: stringValue(item.name) ?? existing?.state.name,
        argumentsText,
      },
      eventName,
    );
  }

  private emitFunctionCall(
    details: {
      itemId?: string;
      callId?: string;
      name?: string;
      argumentsText?: string;
    },
    eventName: string,
  ): readonly TransportEvent[] {
    if (details.callId === undefined || details.name === undefined || details.argumentsText === undefined) {
      this.report("chatgpt.sse.malformed_event", eventName);
      return [];
    }

    let input: unknown;
    try {
      input = JSON.parse(details.argumentsText) as unknown;
    } catch {
      this.report("chatgpt.sse.malformed_event", eventName);
      return [];
    }

    this.deleteFunctionCall(details.itemId, details.callId);
    return [{ type: "tool-call", callId: details.callId, name: details.name, input }];
  }

  private findFunctionCall(
    itemId: string | undefined,
    callId: string | undefined,
  ): { key: string; state: FunctionCallState } | undefined {
    for (const [key, state] of this.functionCalls) {
      if ((callId !== undefined && state.callId === callId) || (itemId !== undefined && state.itemId === itemId)) {
        return { key, state };
      }
    }

    return undefined;
  }

  private deleteFunctionCall(itemId: string | undefined, callId: string | undefined): void {
    for (const [key, state] of this.functionCalls) {
      if (
        (callId !== undefined && (key === callId || state.callId === callId)) ||
        (itemId !== undefined && (key === itemId || state.itemId === itemId))
      ) {
        this.functionCalls.delete(key);
      }
    }
  }

  private emitCompleted(): readonly TransportEvent[] {
    if (this.completed) {
      return [];
    }

    this.completed = true;
    return [{ type: "completed" }];
  }

  private report(name: string, eventName: string | undefined): void {
    try {
      this.logger?.event(name, eventName === undefined ? {} : { eventType: eventName });
    } catch {
      // Diagnostics must never disrupt the protocol parser.
    }
  }
}
