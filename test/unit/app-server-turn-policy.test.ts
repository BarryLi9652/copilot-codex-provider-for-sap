import assert from "node:assert/strict";
import test from "node:test";

import { buildAppServerTurnInstructions } from "../../src/transports/app-server/turn-policy.js";

test("leaves automatic turn instructions unchanged", () => {
  assert.equal(buildAppServerTurnInstructions("base instructions", "auto"), "base instructions");
});

test("requires one supplied dynamic tool without selecting a specific tool", () => {
  const instructions = buildAppServerTurnInstructions("base instructions", "required");

  assert.match(instructions, /^base instructions\n/);
  assert.match(instructions, /requires at least one supplied dynamic tool call/i);
  assert.match(instructions, /do not return a final answer before invoking an applicable supplied tool/i);
  assert.match(instructions, /only use tools that were supplied for this turn/i);
  assert.doesNotMatch(instructions, /replace_string_in_file/);
});
