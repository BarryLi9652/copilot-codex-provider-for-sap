import assert from "node:assert/strict";
import test from "node:test";

import { APP_SERVER_THREAD_CONFIG } from "../../src/transports/app-server/safety-profile.js";

test("builds the exact read-only App Server thread safety profile", () => {
  assert.deepEqual(APP_SERVER_THREAD_CONFIG, {
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    config: {
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.apps": false,
      "features.plugins": false,
      "features.multi_agent": false,
      "features.browser_use": false,
      "features.computer_use": false,
      "features.image_generation": false,
      "features.standalone_web_search": false,
      web_search: "disabled",
      include_apps_instructions: false,
      include_collaboration_mode_instructions: false,
    },
  });

  assert.equal(Object.isFrozen(APP_SERVER_THREAD_CONFIG), true);
  assert.equal(Object.isFrozen(APP_SERVER_THREAD_CONFIG.config), true);
});
