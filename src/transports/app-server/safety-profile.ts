const APP_SERVER_FEATURE_CONFIG = Object.freeze({
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
} as const);

export const APP_SERVER_THREAD_CONFIG = Object.freeze({
  approvalPolicy: "never",
  sandbox: "read-only",
  ephemeral: true,
  config: APP_SERVER_FEATURE_CONFIG,
} as const);
