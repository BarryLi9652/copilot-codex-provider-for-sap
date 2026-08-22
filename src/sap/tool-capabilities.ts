export interface SapToolCapabilities {
  readonly search: readonly string[];
  readonly read: readonly string[];
  readonly resolveWorkspaceUri: readonly string[];
  readonly create: readonly string[];
  readonly edit: readonly string[];
  readonly diagnostics: readonly string[];
  readonly activate: readonly string[];
}

const TOOL_CAPABILITIES = {
  search: new Set([
    "search_abap_objects",
    "search_abap_object_lines",
    "find_where_used",
  ]),
  read: new Set([
    "get_abap_object_lines",
    "get_object_by_uri",
    "get_abap_object_info",
    "get_batch_lines",
  ]),
  resolveWorkspaceUri: new Set(["get_abap_object_workspace_uri"]),
  create: new Set(["create_object_programmatically"]),
  edit: new Set([
    "replace_string_in_abap_object",
    "replace_string_in_file",
    "insert_edit_into_file",
  ]),
  diagnostics: new Set(["get_abap_diagnostics"]),
  activate: new Set(["abap_activate"]),
} as const;

export function classifySapTools(toolNames: readonly string[]): SapToolCapabilities {
  const uniqueToolNames = [...new Set(toolNames)];
  return {
    search: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.search.has(name)),
    read: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.read.has(name)),
    resolveWorkspaceUri: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.resolveWorkspaceUri.has(name)),
    create: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.create.has(name)),
    edit: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.edit.has(name)),
    diagnostics: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.diagnostics.has(name)),
    activate: uniqueToolNames.filter((name) => TOOL_CAPABILITIES.activate.has(name)),
  };
}

export function hasWriteCapability(capabilities: SapToolCapabilities): boolean {
  return capabilities.create.length > 0 || capabilities.edit.length > 0;
}
