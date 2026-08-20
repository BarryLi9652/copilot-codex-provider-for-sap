import { test } from "node:test";
import assert from "node:assert/strict";

import { ResponsesSseParser } from "../../src/transports/chatgpt-oauth/sse-parser.js";

const encoder = new TextEncoder();

function splitUtf8(value: string, cuts: readonly number[]): Uint8Array[] {
  const bytes = encoder.encode(value);
  const points = [0, ...cuts, bytes.byteLength];
  return points.slice(0, -1).map((start, index) => bytes.slice(start, points[index + 1]));
}

test("parses text and tool arguments across arbitrary UTF-8 chunk boundaries", () => {
  const parser = new ResponsesSseParser();
  const stream = [
    "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\r\n\r\n",
    "event: response.function_call_arguments.delta\n",
    "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item-7\",\"call_id\":\"call-7\",\"delta\":\"{\\\"uri\\\":\"adt://DEV/\"}\"}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item-7\",\"type\":\"function_call\",\"call_id\":\"call-7\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}}\n\n",
  ].join("");

  const chunks = splitUtf8(stream, [7, 13, 31, 67, 109, 151]);
  const events = chunks.flatMap((chunk) => parser.push(chunk));

  assert.deepEqual(events, [
    { type: "text-delta", text: "你好" },
    { type: "tool-call", callId: "call-7", name: "get_abap_object_lines", input: {
        uri: "adt://DEV/",
      } },
  ]);
});

test("retains buffered call identity when the terminal item omits call_id", () => {
  const parser = new ResponsesSseParser();
  const stream = [
    "event: response.function_call_arguments.delta\n",
    "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item-8\",\"call_id\":\"call-8\",\"name\":\"get_abap_object_lines\",\"delta\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item-8\",\"type\":\"function_call\",\"name\":\"get_abap_object_lines\"}}\n\n",
  ].join("");

  const events = parser.push(encoder.encode(stream));

  assert.deepEqual(events, [{
    type: "tool-call",
    callId: "call-8",
    name: "get_abap_object_lines",
    input: { uri: "adt://DEV/" },
  }]);
});

test("joins multiline data, ignores DONE and unknown events, and emits completion once", () => {
  const parser = new ResponsesSseParser();
  const chunks = [
    encoder.encode("event: keepalive\ndata: ignored\n\n"),
    encoder.encode("event: response.completed\ndata: {\n"),
    encoder.encode("data: \"type\":\"response.completed\"}\n\n"),
    encoder.encode("data: [DONE]\n\n"),
  ];

  const events = chunks.flatMap((chunk) => parser.push(chunk));

  assert.deepEqual(events, [{ type: "completed" }]);
});

test("does not surface malformed or failed payloads as user content", () => {
  const parser = new ResponsesSseParser();
  const events = parser.push(encoder.encode([
    "event: response.output_text.delta\n",
    "data: not-json\n\n",
    "event: error\n",
    "data: {\"type\":\"error\",\"error\":{\"code\":\"bad_request\"}}\n\n",
    "event: response.failed\n",
    "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n",
  ].join("")));

  assert.deepEqual(events, []);
});

test("reports unknown events without logging payload content", () => {
  const reports: Array<{ name: string; metadata?: Record<string, unknown> }> = [];
  const parser = new ResponsesSseParser({
    event: (name, metadata) => reports.push({ name, metadata }),
  });

  parser.push(encoder.encode([
    "event: response.unknown\n",
    "data: {\"type\":\"response.unknown\",\"delta\":\"do-not-log\"}\n\n",
  ].join("")));

  assert.deepEqual(reports, [{
    name: "chatgpt.sse.unknown_event",
    metadata: { eventType: "response.unknown" },
  }]);
});

test("finish flushes split UTF-8 and a final frame without a delimiter exactly once", () => {
  const parser = new ResponsesSseParser();
  const bytes = encoder.encode([
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}",
  ].join(""));
  const multibyteStart = bytes.indexOf(0xe4);
  assert.notEqual(multibyteStart, -1);

  assert.deepEqual(parser.push(bytes.slice(0, multibyteStart + 1)), []);
  assert.deepEqual(parser.push(bytes.slice(multibyteStart + 1)), []);
  assert.deepEqual(parser.finish(), [{ type: "text-delta", text: "你" }]);
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(parser.push(encoder.encode("data: ignored\n\n")), []);
});

test("finish emits an undelimited completion exactly once", () => {
  const parser = new ResponsesSseParser();
  const finalFrame = encoder.encode([
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\"}",
  ].join(""));

  assert.deepEqual(parser.push(finalFrame), []);
  assert.deepEqual(parser.finish(), [{ type: "completed" }]);
  assert.deepEqual(parser.end(), []);
  assert.deepEqual(parser.push(encoder.encode("data: [DONE]\n\n")), []);
});

test("empty finish and push-after-finish are deterministic", () => {
  const parser = new ResponsesSseParser();

  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(parser.push(encoder.encode([
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ignored\"}\n\n",
  ].join(""))), []);
});

test("finish rejects incomplete terminal UTF-8 without surfacing content", () => {
  const reports: Array<{ name: string; metadata?: Record<string, unknown> }> = [];
  const parser = new ResponsesSseParser({
    event: (name, metadata) => reports.push({ name, metadata }),
  });

  assert.deepEqual(parser.push(Uint8Array.from([0xe2])), []);
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(reports, [{ name: "chatgpt.sse.malformed_utf8", metadata: {} }]);
});

test("rejects malformed terminal UTF-8 without throwing or surfacing content", () => {
  const reports: Array<{ name: string; metadata?: Record<string, unknown> }> = [];
  const parser = new ResponsesSseParser({
    event: (name, metadata) => reports.push({ name, metadata }),
  });

  assert.doesNotThrow(() => parser.push(Uint8Array.from([0xc3, 0x28])));
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(reports, [{ name: "chatgpt.sse.malformed_utf8", metadata: {} }]);
});

test("preserves complete frames before malformed UTF-8 bytes", () => {
  const reports: Array<{ name: string; metadata?: Record<string, unknown> }> = [];
  const parser = new ResponsesSseParser({
    event: (name, metadata) => reports.push({ name, metadata }),
  });
  const validFrame = encoder.encode([
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"safe\"}\n\n",
  ].join(""));
  const chunk = new Uint8Array(validFrame.length + 2);
  chunk.set(validFrame);
  chunk.set([0xc3, 0x28], validFrame.length);

  assert.deepEqual(parser.push(chunk), [{ type: "text-delta", text: "safe" }]);
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(reports, [{ name: "chatgpt.sse.malformed_utf8", metadata: {} }]);
});

test("does not duplicate a tool call when arguments.done precedes output_item.done", () => {
  const parser = new ResponsesSseParser();
  const stream = [
    "event: response.function_call_arguments.done\n",
    "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"item-9\",\"call_id\":\"call-9\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item-9\",\"type\":\"function_call\",\"call_id\":\"call-9\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}}\n\n",
  ].join("");

  assert.deepEqual(parser.push(encoder.encode(stream)), [{
    type: "tool-call",
    callId: "call-9",
    name: "get_abap_object_lines",
    input: { uri: "adt://DEV/" },
  }]);
});

test("does not duplicate a tool call when output_item.done precedes arguments.done", () => {
  const parser = new ResponsesSseParser();
  const stream = [
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"item-10\",\"type\":\"function_call\",\"call_id\":\"call-10\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}}\n\n",
    "event: response.function_call_arguments.done\n",
    "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"item-10\",\"call_id\":\"call-10\",\"name\":\"get_abap_object_lines\",\"arguments\":\"{\\\"uri\\\":\\\"adt://DEV/\\\"}\"}\n\n",
  ].join("");

  assert.deepEqual(parser.push(encoder.encode(stream)), [{
    type: "tool-call",
    callId: "call-10",
    name: "get_abap_object_lines",
    input: { uri: "adt://DEV/" },
  }]);
});

test("ignores comment and metadata-only keepalive frames without unknown-event logs", () => {
  const reports: Array<{ name: string; metadata?: Record<string, unknown> }> = [];
  const parser = new ResponsesSseParser({
    event: (name, metadata) => reports.push({ name, metadata }),
  });

  assert.deepEqual(parser.push(encoder.encode([
    ": comment\n\n",
    "id: 1\nretry: 1000\nevent: keepalive\n\n",
    "id: 2\nretry: 1000\n\n",
  ].join(""))), []);
  assert.deepEqual(reports, []);
});
