export const CHATGPT_VENDOR_ID = "copilot-codex.chatgpt-oauth";
export const LOCAL_VENDOR_ID = "copilot-codex.local-cli";

export const ABAP_FS_EXTENSION_ID = "murbani.vscode-abap-remote-fs";
export const SAP_ADT_EXTENSION_ID = "SAPSE.adt-vscode";
export const SAP_SELECTION_MAX_CHARS = 16_000;
export const SAP_DIAGNOSTICS_MAX = 50;

export const RECOGNIZED_ABAP_TOOL_NAMES = [
  "get_abap_object_lines",
  "search_abap_objects",
  "search_abap_object_lines",
  "get_object_by_uri",
  "get_abap_object_info",
  "find_where_used",
  "get_abap_object_workspace_uri",
] as const;
