import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd()), "..");

function readJson(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8"));
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

// --- Helper to inspect actual Floe LSP (authoritative source) without guessing ---
// Uses local dev path if available, otherwise falls back to npm package
const LOCAL_FLOE_ROOT = path.resolve(ROOT, "../floe");
const FLOE_ROOT = fs.existsSync(LOCAL_FLOE_ROOT) ? LOCAL_FLOE_ROOT : path.resolve(ROOT, "node_modules/@fazelstudio/floe");

function readFloeJson(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(FLOE_ROOT, rel), "utf-8"));
}

describe("Stage 2 — LSP Integration: Inspect actual Floe v1.0 LSP (do not guess)", () => {
  const hasSourceFiles = fs.existsSync(path.join(FLOE_ROOT, "src/lsp/server.ts"));

  it("determines LSP package name and version requirement", () => {
    const pkg = readFloeJson("package.json");
    expect(pkg.name).toBe("@fazelstudio/floe");
    expect(pkg.version).toMatch(/^1\.0\.\d+/);
    // Extension must depend on compatible version (bun allowed)
    const extPkg = readJson("package.json");
    const dep = extPkg.dependencies?.["@fazelstudio/floe"];
    expect(dep).toBeDefined();
    expect(String(dep)).toMatch(/1\.0\.\d+|file:/);
  });

  const cliFile = fs.existsSync(path.join(FLOE_ROOT, "src/cli/main.ts"))
    ? path.join(FLOE_ROOT, "src/cli/main.ts")
    : fs.existsSync(path.join(FLOE_ROOT, "src/cli/main.js"))
    ? path.join(FLOE_ROOT, "src/cli/main.js")
    : null;

  const serverFile = fs.existsSync(path.join(FLOE_ROOT, "src/lsp/server.ts"))
    ? path.join(FLOE_ROOT, "src/lsp/server.ts")
    : fs.existsSync(path.join(FLOE_ROOT, "src/lsp/server.js"))
    ? path.join(FLOE_ROOT, "src/lsp/server.js")
    : null;

  const itSkipIfNoSource = (condition: boolean) => (condition ? it.skip : it);

  itSkipIfNoSource(!cliFile || !serverFile)("determines server entry point and transport", () => {
    const pkg = readFloeJson("package.json");
    // Exports must include ./lsp
    expect(pkg.exports?.["./lsp"]).toBeDefined();
    expect(pkg.exports["./lsp"].import).toMatch(/dist\/src\/lsp\/server\.js/);
    // bin must include floe cli
    expect(pkg.bin?.floe).toBe("./dist/src/cli/main.js");
    // CLI supports lsp --stdio
    const cli = fs.readFileSync(cliFile!, "utf-8");
    expect(cli).toMatch(/lsp/);
    expect(cli).toMatch(/--stdio/);
    expect(cli).toMatch(/startLspServer/);
    // Server uses stdio transport only (no socket/ipc)
    const server = fs.readFileSync(serverFile!, "utf-8");
    expect(server).toMatch(/Content-Length/);
    expect(server).toMatch(/stdio/);
    expect(server).not.toMatch(/socket/i);
    // Verify dist exists
    expect(fs.existsSync(path.join(FLOE_ROOT, "dist/src/lsp/server.js"))).toBe(true);
    expect(fs.existsSync(path.join(FLOE_ROOT, "dist/src/cli/main.js"))).toBe(true);
  });

  itSkipIfNoSource(!serverFile)("determines startup arguments and supported capabilities (from actual server implementation)", async () => {
    const serverText = fs.readFileSync(serverFile!, "utf-8");
    // Check capabilities advertised in handleInitialize
    expect(serverText).toMatch(/textDocumentSync/);
    expect(serverText).toMatch(/completionProvider/);
    expect(serverText).toMatch(/hoverProvider/);
    expect(serverText).toMatch(/definitionProvider/);
    expect(serverText).toMatch(/referencesProvider/);
    expect(serverText).toMatch(/renameProvider/);
    expect(serverText).toMatch(/documentFormattingProvider/);
    expect(serverText).toMatch(/documentSymbolProvider/);
    expect(serverText).toMatch(/foldingRangeProvider/);
    expect(serverText).toMatch(/diagnosticProvider/);
    // Trigger characters
    expect(serverText).toMatch(/triggerCharacters/);
    // Sync mode Full (1)
    expect(serverText).toMatch(/change:\s*1/);
    // Also verify at runtime via dynamic import
    const { FloeLspServer } = await import(path.join(FLOE_ROOT, "dist/src/lsp/server.js"));
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const output = new PassThrough();
    const srv: any = new FloeLspServer({ input, output });
    const sent: any[] = [];
    srv.send = (msg: any) => sent.push(msg);
    await srv.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(sent.length).toBe(1);
    const caps = sent[0].result.capabilities;
    expect(caps.textDocumentSync).toBeDefined();
    expect(caps.completionProvider).toBeDefined();
    expect(caps.hoverProvider).toBe(true);
    expect(caps.definitionProvider).toBe(true);
    expect(caps.referencesProvider).toBe(true);
    expect(caps.renameProvider).toBeDefined();
    expect(caps.documentFormattingProvider).toBe(true);
    expect(caps.documentSymbolProvider).toBe(true);
    expect(caps.foldingRangeProvider).toBe(true);
    // Verify server reuses language services, not duplicate parser
    expect(serverText).toMatch(/from "..\/language\//);
    expect(serverText).not.toMatch(/class Parser/);
    expect(serverText).not.toMatch(/vscode-languageserver/);
  });

  itSkipIfNoSource(!serverFile)("determines dependency/version requirements — ESM, no global install needed", () => {
    const floePkg = readFloeJson("package.json");
    // Type module (ES2022) — Node can spawn via node entry
    expect(floePkg.type).toBe("module");
    // No dependency on vscode
    const server = fs.readFileSync(serverFile!, "utf-8");
    expect(server).not.toMatch(/vscode/);
    expect(server).not.toMatch(/CodeMirror/);
    // VS Code extension should bundle, not require global
    const extPkg = readJson("package.json");
    expect(extPkg.dependencies["@fazelstudio/floe"]).toBeDefined();
    expect(extPkg.dependencies["vscode-languageclient"]).toMatch(/^\^?9\./);
  });
});

describe("Stage 2 — Extension as LSP client (reuses existing LSP)", () => {
  let extText: string;
  beforeAll(() => {
    extText = readText("src/extension.ts");
  });

  it("implements VS Code LanguageClient (standard pattern) over stdio", () => {
    expect(extText).toMatch(/from\s+["']vscode-languageclient\/node["']/);
    expect(extText).toMatch(/LanguageClient/);
    expect(extText).toMatch(/TransportKind\.stdio/);
    expect(extText).toMatch(/ServerOptions/);
    expect(extText).toMatch(/LanguageClientOptions/);
    // Must not reimplement parser/formatter/validator
    expect(extText).not.toMatch(/class Lexer/);
    expect(extText).not.toMatch(/class Parser/);
    expect(extText).not.toMatch(/new Parser/);
    expect(extText).not.toMatch(/function format\s*\(/); // formatter is delegated
    expect(extText).not.toMatch(/function parseFloe/);
    // Must not depend on CodeMirror directly
    expect(extText).not.toMatch(/CodeMirror/);
  });

  it("exposes every stable capability actually supported by the LSP (no fake capabilities)", () => {
    // Client document selector must be floe for file + untitled, allowing all capabilities to be routed
    expect(extText).toMatch(/documentSelector/);
    expect(extText).toMatch(/language:\s*["']floe["']/);
    expect(extText).toMatch(/scheme:\s*["']file["']/);
    expect(extText).toMatch(/scheme:\s*["']untitled["']/);
    // Ensure we don't fake capabilities: extension should not manually register duplicate providers that already come from LSP
    // It should rely on client, not vscode.languages.registerCompletionItemProvider etc for floe
    expect(extText).not.toMatch(/registerCompletionItemProvider.*floe/);
    expect(extText).not.toMatch(/registerHoverProvider.*floe/);
    // It should not implement its own diagnostics collection via manual parsing; should use diagnosticCollectionName via client
    expect(extText).toMatch(/diagnosticCollectionName/);
    expect(extText).toMatch(/["']floe["']/);
  });

  it("resolves LSP without requiring global install (bundled/workspace discovery)", () => {
    expect(extText).toMatch(/resolveFloeServerPath/);
    expect(extText).toMatch(/node_modules.*@fazelstudio.*floe/);
    expect(extText).toMatch(/asAbsolutePath/);
    expect(extText).toMatch(/workspaceFolders/);
    expect(extText).toMatch(/languageServer\.path/);
    // Must handle custom path, workspace, bundled, and require.resolve
    expect(extText).toMatch(/require\.resolve/);
    expect(extText).toMatch(/source.*bundled|bundled/);
    expect(extText).toMatch(/source.*workspace|workspace/);
    expect(extText).toMatch(/source.*custom|custom/);
    // Startup args must be lsp --stdio for cli entry
    expect(extText).toMatch(/lsp/);
    expect(extText).toMatch(/--stdio/);
    // Must not expect global npm install -g
    expect(extText).not.toMatch(/npm install -g/);
  });

  it("handles LSP startup failures gracefully (no crash, actionable message)", () => {
    expect(extText).toMatch(/try\s*\{[\s\S]*client\.start/);
    expect(extText).toMatch(/catch/);
    expect(extText).toMatch(/showErrorMessage|showWarningMessage/);
    expect(extText).toMatch(/Floe.*not found|Failed to start/);
    expect(extText).toMatch(/outputChannel/);
    expect(extText).not.toMatch(/\bthrow\s+\(/); // should not rethrow startup failure as crash (throw statements only)
  });

  it("handles server crashes/exits with ErrorHandler and restart limits", () => {
    expect(extText).toMatch(/ErrorHandler/);
    expect(extText).toMatch(/ErrorAction/);
    expect(extText).toMatch(/CloseAction/);
    expect(extText).toMatch(/DoNotRestart/);
    expect(extText).toMatch(/Restart/);
    expect(extText).toMatch(/MAX_RESTARTS|restart/);
    expect(extText).toMatch(/crashed repeatedly/);
  });

  it("handles incompatible versions (serverInfo.version check)", () => {
    expect(extText).toMatch(/serverInfo\.version|initializeResult/);
    expect(extText).toMatch(/getBundledVersion|bundledVersion/);
    expect(extText).toMatch(/version mismatch|WARNING/);
    expect(extText).toMatch(/showWarningMessage/);
  });

  it("handles malformed documents without crashing (middleware/defensive)", () => {
    // Server already never crashes on malformed; extension should defensively handle
    expect(extText).toMatch(/handleDiagnostics/);
    expect(extText).toMatch(/not.*crash|malformed/i);
    // No eval
    expect(extText).not.toMatch(/\beval\s*\(/);
    expect(extText).not.toMatch(/new Function/);
  });

  it("handles multiple .floe documents (documentSelector covers file+untitled)", () => {
    expect(extText).toMatch(/file/);
    expect(extText).toMatch(/untitled/);
    // Also watches open
    expect(extText).toMatch(/onDidOpenTextDocument/);
  });

  it("handles extension reload (deactivate stops client)", () => {
    expect(extText).toMatch(/export\s+(async\s+)?function\s+deactivate/);
    expect(extText).toMatch(/client\.stop/);
    expect(extText).toMatch(/await client\.stop/);
  });

  it("exposes configuration without requiring manual global install", () => {
    const pkg = readJson("package.json");
    const props = pkg.contributes?.configuration?.properties;
    expect(props).toBeDefined();
    expect(props["floe.languageServer.enabled"]).toBeDefined();
    expect(props["floe.languageServer.path"]).toBeDefined();
    expect(props["floe.trace.server"]).toBeDefined();
    // Restart command
    const cmds = pkg.contributes?.commands ?? [];
    const restart = cmds.find((c: any) => c.command === "floe.restartLanguageServer");
    expect(restart).toBeDefined();
    expect(restart.title).toMatch(/Restart/);
  });

  it("implements preview with webview (Stage 3)", () => {
    const pkg = readJson("package.json");
    const cmds = pkg.contributes?.commands ?? [];
    const preview = cmds.find((c: any) => /preview/i.test(c.command));
    expect(preview).toBeDefined();
    expect(extText).toMatch(/previewManager|Preview/);
    expect(extText).toMatch(/registerPreviewCommands/);
  });

  it("uses output channel and not duplicate formatter", () => {
    expect(extText).toMatch(/createOutputChannel.*Floe/);
    expect(extText).toMatch(/outputChannel/);
    // Ensure formatting is not reimplemented
    expect(extText).not.toMatch(/format.*indentStr/);
    expect(extText).not.toMatch(/INDENT/);
  });
});

describe("Stage 2 — LSP integration runtime: diagnostics & formatting via server", () => {
  it("server provides diagnostics for invalid direction and formatting for A->B", async () => {
    const { FloeLspServer } = await import(path.join(FLOE_ROOT, "dist/src/lsp/server.js"));
    const { PassThrough } = await import("node:stream");
    const input = new PassThrough();
    const output = new PassThrough();
    const srv: any = new FloeLspServer({ input, output });
    const sent: any[] = [];
    srv.send = (msg: any) => sent.push(msg);

    // Open malformed doc
    await srv.handleNotification({
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///test.floe", languageId: "floe", version: 1, text: "direction XX\nA ->" } },
    });
    const diagNotif = sent.find((m) => m.method === "textDocument/publishDiagnostics");
    expect(diagNotif).toBeDefined();
    expect(diagNotif.params.diagnostics.length).toBeGreaterThan(0);
    const codes = diagNotif.params.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("E001");
    // Diagnostics should have LSP ranges
    expect(diagNotif.params.diagnostics[0].range.start.line).toBeGreaterThanOrEqual(0);

    // Formatting: A->B => A -> B
    sent.length = 0;
    await srv.handleNotification({
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///fmt.floe", languageId: "floe", version: 1, text: "A->B\n" } },
    });
    const edits = await srv.handleFormatting({ textDocument: { uri: "file:///fmt.floe" } });
    expect(edits.length).toBe(1);
    expect(edits[0].newText).toBe("A -> B\n");

    // Completion after direction
    const comp = await srv.handleCompletion({ textDocument: { uri: "file:///fmt.floe" }, position: { line: 0, character: 0 } });
    // Completion may be at least not null; for fmt file not meaningful but should not crash
    expect(comp).toBeDefined();

    // Hover on valid identifier
    const { FloeLspServer: S2 } = await import(path.join(FLOE_ROOT, "dist/src/lsp/server.js"));
    const i2 = new PassThrough(); const o2 = new PassThrough();
    const srv2: any = new S2({ input: i2, output: o2 });
    srv2.send = () => {};
    await srv2.handleNotification({ method: "textDocument/didOpen", params: { textDocument: { uri: "file:///hover.floe", languageId: "floe", version: 1, text: "User [person] \"End User\"\nUser -> Login" } } });
    const hover = await srv2.handleHover({ textDocument: { uri: "file:///hover.floe" }, position: { line: 0, character: 1 } });
    expect(hover).not.toBeNull();
    expect(hover.contents.length).toBeGreaterThan(0);

    // Definition
    const def = await srv2.handleDefinition({ textDocument: { uri: "file:///hover.floe" }, position: { line: 1, character: 1 } });
    expect(def).not.toBeNull();
    expect(def.range).toBeDefined();

    // References
    const refs = await srv2.handleReferences({ textDocument: { uri: "file:///hover.floe" }, position: { line: 0, character: 1 } });
    expect(refs.length).toBeGreaterThan(0);

    // Rename
    const ren = await srv2.handleRename({ textDocument: { uri: "file:///hover.floe" }, position: { line: 0, character: 1 }, newName: "Customer" });
    expect(ren).not.toBeNull();
    expect(ren.changes["file:///hover.floe"].length).toBeGreaterThan(0);

    // Symbols
    const syms = await srv2.handleDocumentSymbol({ textDocument: { uri: "file:///hover.floe" } });
    expect(syms.length).toBeGreaterThan(0);

    // Folding
    await srv2.handleNotification({ method: "textDocument/didOpen", params: { textDocument: { uri: "file:///fold.floe", languageId: "floe", version: 1, text: "group Backend {\n  API\n}\n" } } });
    const folds = await srv2.handleFoldingRange({ textDocument: { uri: "file:///fold.floe" } });
    expect(folds.length).toBe(1);
    expect(folds[0].startLine).toBe(0);

    // Malformed never crashes
    await srv2.handleNotification({ method: "textDocument/didOpen", params: { textDocument: { uri: "file:///bad.floe", languageId: "floe", version: 1, text: "!!!\n-> ->\nUser [" } } });
    const badComp = await srv2.handleCompletion({ textDocument: { uri: "file:///bad.floe" }, position: { line: 0, character: 0 } });
    expect(badComp).toBeDefined();

    // Incremental didChange
    const { PassThrough: PT } = await import("node:stream");
    const s3: any = new FloeLspServer({ input: new PT(), output: new PT() });
    const captured: any[] = []; s3.send = (m: any) => captured.push(m);
    await s3.handleNotification({ method: "textDocument/didOpen", params: { textDocument: { uri: "file:///incr.floe", languageId: "floe", version: 1, text: "A -> B" } } });
    captured.length = 0;
    await s3.handleNotification({ method: "textDocument/didChange", params: { textDocument: { uri: "file:///incr.floe", version: 2 }, contentChanges: [{ text: "A -> C" }] } });
    const d2 = captured.find((m) => m.method === "textDocument/publishDiagnostics");
    expect(d2).toBeDefined();
    expect(d2.params.diagnostics.filter((d: any) => d.severity === 1)).toHaveLength(0);

    // DidClose clears diagnostics
    captured.length = 0;
    await s3.handleNotification({ method: "textDocument/didClose", params: { textDocument: { uri: "file:///incr.floe" } } });
    const cleared = captured.find((m) => m.method === "textDocument/publishDiagnostics" && m.params.diagnostics.length === 0);
    expect(cleared).toBeDefined();
  });

  it("client package & build artifacts are correct", () => {
    const pkg = readJson("package.json");
    // Activation
    expect(pkg.activationEvents).toContain("onLanguage:floe");
    expect(pkg.main).toBe("./dist/extension.js");
    expect(pkg.engines.vscode).toMatch(/^\^1\.\d+/);
    // Preview commands exist (Stage 3)
    const cmds = pkg.contributes?.commands ?? [];
    expect(cmds.some((c: any) => /preview/i.test(c.command))).toBe(true);
    // Extension should bundle server files via .vscodeignore allowlist
    const vscodeignore = fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf-8");
    expect(vscodeignore).toMatch(/!node_modules\/@fazelstudio\/floe/);
    expect(vscodeignore).toMatch(/!node_modules\/vscode-languageclient/);
    // Dist built
    expect(fs.existsSync(path.join(ROOT, "dist/extension.js"))).toBe(true);
    const dist = fs.readFileSync(path.join(ROOT, "dist/extension.js"), "utf-8");
    expect(dist).toMatch(/LanguageClient/);
    expect(dist).toMatch(/Floe Language Server/);
    // Tsconfig module supports subpath exports (NodeNext or CommonJS)
    const tsconfig = readJson("tsconfig.json");
    const mod = tsconfig.compilerOptions?.module?.toLowerCase();
    expect(mod === "nodenext" || mod === "node16" || mod === "commonjs").toBe(true);
  });
});
