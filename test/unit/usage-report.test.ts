import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUsagePayload,
  COPILOT_USAGE_DATA_PART_MIME_TYPE,
  encodeUsagePayloadJson,
} from "../../src/core/usage-report.js";

test("usage mime type matches the Copilot agent-host bridge contract", () => {
  assert.equal(COPILOT_USAGE_DATA_PART_MIME_TYPE, "usage");
});

test("usage payload follows the OpenAI usage shape", () => {
  const payload = buildUsagePayload(18757, 9984, 13);

  assert.deepEqual(payload, {
    prompt_tokens: 18757,
    completion_tokens: 13,
    total_tokens: 18770,
    prompt_tokens_details: { cached_tokens: 9984 },
  });
});

test("usage payload total includes cached tokens in prompt tokens", () => {
  // OpenAI semantics: prompt_tokens already contains cached tokens, so the
  // total is input + output without adding cached tokens a second time.
  const payload = buildUsagePayload(1000, 1000, 100);

  assert.equal(payload.total_tokens, 1100);
});

test("usage payload encodes to valid JSON", () => {
  const json = encodeUsagePayloadJson(buildUsagePayload(10, 5, 2));

  assert.deepEqual(JSON.parse(json), {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 5 },
  });
});
