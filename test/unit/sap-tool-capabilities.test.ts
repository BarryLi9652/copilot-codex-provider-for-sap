import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySapTools,
  hasWriteCapability,
} from "../../src/sap/tool-capabilities.js";

test("classifies the supplied SAP tools by capability", () => {
  const capabilities = classifySapTools([
    "get_abap_object_lines",
    "get_abap_object_workspace_uri",
    "replace_string_in_file",
    "get_abap_diagnostics",
    "abap_activate",
  ]);

  assert.deepEqual(capabilities, {
    search: [],
    read: ["get_abap_object_lines"],
    resolveWorkspaceUri: ["get_abap_object_workspace_uri"],
    create: [],
    edit: ["replace_string_in_file"],
    diagnostics: ["get_abap_diagnostics"],
    activate: ["abap_activate"],
  });
  assert.equal(hasWriteCapability(capabilities), true);
});

test("does not report write capability for read-only supplied tools", () => {
  const capabilities = classifySapTools([
    "get_abap_object_lines",
    "search_abap_objects",
  ]);

  assert.equal(hasWriteCapability(capabilities), false);
});

test("ignores unknown tools without rejecting classification", () => {
  assert.deepEqual(classifySapTools(["future_abap_tool"]), {
    search: [],
    read: [],
    resolveWorkspaceUri: [],
    create: [],
    edit: [],
    diagnostics: [],
    activate: [],
  });
});
