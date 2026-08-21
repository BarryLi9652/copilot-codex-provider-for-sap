import * as vscode from "vscode";

import {
  ABAP_FS_EXTENSION_ID,
  SAP_ADT_EXTENSION_ID,
  SAP_DIAGNOSTICS_MAX,
  SAP_SELECTION_MAX_CHARS,
} from "../constants.js";

export interface SapContext {
  abapFsInstalled: boolean;
  adtInstalled: boolean;
  activeDocument?: {
    uri: string;
    languageId: string;
    dirty: boolean;
    selection?: string;
  };
  diagnostics: readonly {
    severity: string;
    message: string;
    range: string;
  }[];
}

export interface SapContextProviderOptions {
  readonly activeTextEditor?: () => vscode.TextEditor | undefined;
  readonly getDiagnostics?: (uri: vscode.Uri) => readonly vscode.Diagnostic[];
  readonly getExtension?: (id: string) => unknown;
  readonly getSelectionMaxChars?: () => number;
}

const diagnosticSeverity = (severity: vscode.DiagnosticSeverity): string => {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
};

const diagnosticRange = (range: vscode.Range): string =>
  `${range.start.line + 1}:${range.start.character + 1}`
  + `-${range.end.line + 1}:${range.end.character + 1}`;

const configuredSelectionMaxChars = (): number => {
  const configured = vscode.workspace
    .getConfiguration("copilotCodex")
    .get<number>("sapSelectionMaxChars", SAP_SELECTION_MAX_CHARS);
  if (!Number.isFinite(configured)) {
    return SAP_SELECTION_MAX_CHARS;
  }
  return Math.max(0, Math.floor(configured));
};

export class SapContextProvider {
  private readonly activeTextEditor: () => vscode.TextEditor | undefined;
  private readonly getDiagnostics: (uri: vscode.Uri) => readonly vscode.Diagnostic[];
  private readonly getExtension: (id: string) => unknown;
  private readonly getSelectionMaxChars: () => number;

  public constructor(options: SapContextProviderOptions = {}) {
    this.activeTextEditor = options.activeTextEditor ?? (() => vscode.window.activeTextEditor);
    this.getDiagnostics = options.getDiagnostics ?? ((uri) => vscode.languages.getDiagnostics(uri));
    this.getExtension = options.getExtension ?? ((id) => vscode.extensions.getExtension(id));
    this.getSelectionMaxChars = options.getSelectionMaxChars ?? configuredSelectionMaxChars;
  }

  public collect(): SapContext {
    const editor = this.activeTextEditor();
    const activeDocument = editor === undefined ? undefined : this.collectActiveDocument(editor);
    const diagnostics = editor === undefined
      ? []
      : this.getDiagnostics(editor.document.uri)
        .slice(0, SAP_DIAGNOSTICS_MAX)
        .map((diagnostic) => ({
          severity: diagnosticSeverity(diagnostic.severity),
          message: diagnostic.message,
          range: diagnosticRange(diagnostic.range),
        }));

    return {
      abapFsInstalled: this.getExtension(ABAP_FS_EXTENSION_ID) !== undefined,
      adtInstalled: this.getExtension(SAP_ADT_EXTENSION_ID) !== undefined,
      ...(activeDocument === undefined ? {} : { activeDocument }),
      diagnostics,
    };
  }

  private collectActiveDocument(editor: vscode.TextEditor): NonNullable<SapContext["activeDocument"]> {
    const { document, selection } = editor;
    const selectedText = selection.isEmpty
      ? undefined
      : document.getText(selection).slice(0, this.getSelectionMaxChars());

    return {
      uri: document.uri.toString(true),
      languageId: document.languageId,
      dirty: document.isDirty,
      ...(selectedText === undefined ? {} : { selection: selectedText }),
    };
  }
}
