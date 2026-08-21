import assert from "node:assert/strict";

import * as vscode from "vscode";

import {
  ABAP_FS_EXTENSION_ID,
  SAP_ADT_EXTENSION_ID,
  SAP_SELECTION_MAX_CHARS,
} from "../../../src/constants.js";
import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "../../../src/core/types.js";
import { CodexLanguageModelProvider } from "../../../src/providers/codex-provider.js";
import { SapContextProvider, type SapContext } from "../../../src/sap/context.js";
import { buildSapInstructions } from "../../../src/sap/instructions.js";

const encoder = new TextEncoder();

class InMemoryAdtFileSystem implements vscode.FileSystemProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private content: Uint8Array;

  public readFileCalls = 0;

  public readonly onDidChangeFile = this.changeEmitter.event;

  public constructor(content: string) {
    this.content = encoder.encode(content);
  }

  public watch(_uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  public stat(_uri: vscode.Uri): vscode.FileStat {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: this.content.byteLength,
    };
  }

  public readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  public createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  public readFile(_uri: vscode.Uri): Uint8Array {
    this.readFileCalls += 1;
    return this.content.slice();
  }

  public writeFile(_uri: vscode.Uri, content: Uint8Array): void {
    this.content = content.slice();
  }

  public delete(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  public rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}

interface AdtEditorFixture {
  readonly document: vscode.TextDocument;
  readonly editor: vscode.TextEditor;
  readonly fileSystem: InMemoryAdtFileSystem;
  readonly uri: vscode.Uri;
}

async function withAdtEditor<T>(
  content: string,
  path: string,
  callback: (fixture: AdtEditorFixture) => Promise<T>,
): Promise<T> {
  const fileSystem = new InMemoryAdtFileSystem(content);
  const registration = vscode.workspace.registerFileSystemProvider(
    "adt",
    fileSystem,
    { isCaseSensitive: true },
  );
  const uri = vscode.Uri.parse(`adt://DEV/src/${path}.clas.abap`);

  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    return await callback({ document, editor, fileSystem, uri });
  } finally {
    registration.dispose();
  }
}

const model: CodexModel = {
  id: "gpt-sap-test",
  name: "GPT SAP Test",
  family: "gpt",
  version: "1",
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  capabilities: {
    imageInput: false,
    toolCalling: true,
    parallelToolCalls: false,
  },
};

const modelInformation: vscode.LanguageModelChatInformation = {
  id: model.id,
  name: model.name,
  family: model.family,
  version: model.version,
  maxInputTokens: model.maxInputTokens,
  maxOutputTokens: model.maxOutputTokens,
  capabilities: {
    imageInput: model.capabilities.imageInput,
    toolCalling: model.capabilities.toolCalling,
  },
};

function createTransport(onRequest: (request: CodexRequest) => void): CodexTransport {
  return {
    listModels: async () => [model],
    generate: async function* (request: CodexRequest): AsyncIterable<TransportEvent> {
      onRequest(request);
      yield { type: "completed" };
    },
    dispose: async () => undefined,
  };
}

async function collectsUnsavedAdtSelectionAndDiagnostics(): Promise<void> {
  const source = "CLASS zcl_demo DEFINITION.\n  METHODS run.\nENDCLASS.\n";

  await withAdtEditor(source, "zcl_demo", async ({ document, editor, fileSystem, uri }) => {
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "* unsaved\n"));
    const selectionText = "METHODS run.";
    const selectionStart = document.getText().indexOf(selectionText);
    editor.selection = new vscode.Selection(
      document.positionAt(selectionStart),
      document.positionAt(selectionStart + selectionText.length),
    );

    const diagnostics = vscode.languages.createDiagnosticCollection("copilot-codex-task-11");
    diagnostics.set(uri, [new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(1, 2), new vscode.Position(1, 14)),
      "ABAP syntax error",
      vscode.DiagnosticSeverity.Error,
    )]);

    try {
      const readsBeforeCollect = fileSystem.readFileCalls;
      const context = new SapContextProvider().collect();

      assert.equal(context.activeDocument?.uri, uri.toString(true));
      assert.equal(context.activeDocument?.languageId, document.languageId);
      assert.equal(context.activeDocument?.dirty, true);
      assert.equal(context.activeDocument?.selection, selectionText);
      assert.deepEqual(context.diagnostics, [{
        severity: "error",
        message: "ABAP syntax error",
        range: "2:3-2:15",
      }]);
      assert.equal(fileSystem.readFileCalls, readsBeforeCollect);
      assert.match(context.activeDocument?.uri ?? "", /^adt:\/\/[^/]+\//);
    } finally {
      diagnostics.dispose();
    }
  });
}

async function boundsSelectionAndDiagnostics(): Promise<void> {
  const content = "A".repeat(SAP_SELECTION_MAX_CHARS + 5);

  await withAdtEditor(content, "bounded", async ({ document, editor, uri }) => {
    editor.selection = new vscode.Selection(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    );
    const diagnostics = vscode.languages.createDiagnosticCollection("copilot-codex-task-11-bounded");
    diagnostics.set(uri, Array.from({ length: 55 }, (_, index) => new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
      `diagnostic-${index}`,
      vscode.DiagnosticSeverity.Warning,
    )));

    try {
      const context = new SapContextProvider().collect();
      assert.equal(context.activeDocument?.selection?.length, SAP_SELECTION_MAX_CHARS);
      assert.equal(context.diagnostics.length, 50);
      assert.equal(context.diagnostics[49]?.message, "diagnostic-49");
    } finally {
      diagnostics.dispose();
    }
  });
}

async function doesNotReadFullDocumentForEmptySelection(): Promise<void> {
  let getTextCalls = 0;
  const uri = vscode.Uri.parse("adt://DEV/src/empty-selection.clas.abap");
  const guardedUri = new Proxy(uri, {
    get(target, property) {
      if (property === "fsPath") {
        throw new Error("adt:// context must not read fsPath");
      }
      if (property === "toString") {
        return target.toString.bind(target);
      }
      return Reflect.get(target, property, target);
    },
  });
  const document = {
    uri: guardedUri,
    languageId: "abap",
    isDirty: true,
    getText: (): string => {
      getTextCalls += 1;
      throw new Error("full document text must not be collected");
    },
  } as unknown as vscode.TextDocument;
  const editor = {
    document,
    selection: new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
  } as unknown as vscode.TextEditor;

  const context = new SapContextProvider({
    activeTextEditor: () => editor,
    getDiagnostics: () => [],
    getExtension: () => undefined,
  }).collect();

  assert.equal(getTextCalls, 0);
  assert.equal(context.activeDocument?.selection, undefined);
}

async function detectsOnlyTheTwoSupportedExtensions(): Promise<void> {
  const requestedIds: string[] = [];
  const context = new SapContextProvider({
    activeTextEditor: () => undefined,
    getDiagnostics: () => [],
    getExtension: (id) => {
      requestedIds.push(id);
      return id === ABAP_FS_EXTENSION_ID ? { id } : undefined;
    },
  }).collect();

  assert.deepEqual(requestedIds, [ABAP_FS_EXTENSION_ID, SAP_ADT_EXTENSION_ID]);
  assert.equal(context.abapFsInstalled, true);
  assert.equal(context.adtInstalled, false);
}

function buildsInstructionsFromOnlyCurrentlySuppliedAbapTools(): void {
  const context: SapContext = {
    abapFsInstalled: true,
    adtInstalled: true,
    activeDocument: {
      uri: "adt://DEV/src/zcl_demo.clas.abap",
      languageId: "abap",
      dirty: true,
      selection: "METHODS run.",
    },
    diagnostics: [],
  };
  const instructions = buildSapInstructions(context, [
    "get_abap_object_lines",
    "write_abap_object",
    "not-an-abap-tool",
  ]);
  const withoutReadTool = buildSapInstructions(context, ["write_abap_object"]);

  assert.match(instructions, /prefer supplied semantic ABAP tools/i);
  assert.match(instructions, /do not recursively enumerate `adt:\/\/`/i);
  assert.match(instructions, /use open document text for unsaved content/i);
  assert.match(instructions, /modifying\/activating actions only after explicit user intent/i);
  assert.match(instructions, /Copilot owns approval and execution/i);
  assert.match(instructions, /get_abap_object_lines/);
  assert.doesNotMatch(instructions, /write_abap_object/);
  assert.doesNotMatch(withoutReadTool, /get_abap_object_lines/);
}

async function bothProviderRoutesUseSharedSapInstructions(): Promise<void> {
  const requests: CodexRequest[] = [];
  const sapContextProvider = new SapContextProvider({
    activeTextEditor: () => undefined,
    getDiagnostics: () => [],
    getExtension: () => undefined,
  });

  for (const vendor of ["chatgpt-route", "local-route"]) {
    const provider = new CodexLanguageModelProvider(
      createTransport((request) => requests.push(request)),
      vendor,
      { sapContextProvider },
    );
    const cancellation = new vscode.CancellationTokenSource();
    try {
      await provider.provideLanguageModelChatResponse(
        modelInformation,
        [],
        {
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          tools: [{
            name: "get_abap_object_lines",
            description: "Read ABAP lines",
            inputSchema: { type: "object" },
          }],
        },
        { report: () => undefined },
        cancellation.token,
      );
    } finally {
      cancellation.dispose();
    }
  }

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(request.instructions, /get_abap_object_lines/);
    assert.match(request.instructions, /Copilot owns approval and execution/);
  }
}

export async function runSapTests(): Promise<void> {
  const tests: readonly (readonly [string, () => Promise<void>])[] = [
    ["SAP context collects unsaved adt:// selection and diagnostics", collectsUnsavedAdtSelectionAndDiagnostics],
    ["SAP context bounds selection and diagnostics", boundsSelectionAndDiagnostics],
    ["SAP context omits full document text for an empty selection", doesNotReadFullDocumentForEmptySelection],
    ["SAP context detects only the supported extension IDs", detectsOnlyTheTwoSupportedExtensions],
    ["SAP instructions include only currently supplied recognized tools", async () => {
      buildsInstructionsFromOnlyCurrentlySuppliedAbapTools();
    }],
    ["both provider routes use shared SAP instructions", bothProviderRoutesUseSharedSapInstructions],
  ];

  for (const [name, test] of tests) {
    await test();
    console.log(`✔ ${name}`);
  }
}
