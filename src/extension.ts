import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  ErrorAction,
  CloseAction,
  ErrorHandler,
  State,
  Trace,
} from "vscode-languageclient/node";
import {
  registerPreviewCommands,
  registerPreviewSync,
  disposeAllPreviews,
  getPreviewStats,
} from "./preview/previewManager";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let restartCount = 0;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 3 * 60 * 1000;
const restartTimestamps: number[] = [];
let activationStartTime = 0;

// For diagnostics latency measurement: time of last change per uri
const diagnosticChangeTimes = new Map<string, number>();

export function __resetForTests(): void {
  client = undefined;
  outputChannel = undefined;
  restartCount = 0;
  restartTimestamps.length = 0;
  activationStartTime = 0;
  diagnosticChangeTimes.clear();
}

interface ResolvedServer {
  modulePath: string;
  source: "custom" | "workspace" | "bundled";
  version?: string;
}

export function resolveFloeServerPath(context: vscode.ExtensionContext, output: vscode.OutputChannel): ResolvedServer | null {
  const config = vscode.workspace.getConfiguration("floe");
  const custom = (config.get<string>("languageServer.path") ?? "").trim();

  const candidates: { p: string; src: ResolvedServer["source"] }[] = [];

  if (custom) {
    candidates.push({ p: custom, src: "custom" });
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const base = folder.uri.fsPath;
    candidates.push({ p: path.join(base, "node_modules", "@fazelstudio", "floe", "dist", "src", "cli", "main.js"), src: "workspace" });
    candidates.push({ p: path.join(base, "node_modules", "@fazelstudio", "floe", "dist", "src", "lsp", "server.js"), src: "workspace" });
  }

  const bundledCli = context.asAbsolutePath(path.join("bundled", "@fazelstudio", "floe", "dist", "src", "cli", "main.js"));
  const bundledServer = context.asAbsolutePath(path.join("bundled", "@fazelstudio", "floe", "dist", "src", "lsp", "server.js"));
  candidates.push({ p: bundledCli, src: "bundled" });
  candidates.push({ p: bundledServer, src: "bundled" });

  try {
    const resolvedCli = require.resolve("@fazelstudio/floe/dist/src/cli/main.js");
    if (resolvedCli) candidates.push({ p: resolvedCli, src: "bundled" });
  } catch { /* ignore */ }
  try {
    const resolvedSrv = require.resolve("@fazelstudio/floe/dist/src/lsp/server.js");
    if (resolvedSrv) candidates.push({ p: resolvedSrv, src: "bundled" });
  } catch { /* ignore */ }

  const nodeModulesCli = context.asAbsolutePath(path.join("node_modules", "@fazelstudio", "floe", "dist", "src", "cli", "main.js"));
  const nodeModulesServer = context.asAbsolutePath(path.join("node_modules", "@fazelstudio", "floe", "dist", "src", "lsp", "server.js"));
  candidates.push({ p: nodeModulesCli, src: "bundled" });
  candidates.push({ p: nodeModulesServer, src: "bundled" });

  for (const c of candidates) {
    if (fs.existsSync(c.p)) {
      let ver: string | undefined;
      try {
        const pkgPath = resolvePackageJsonFor(c.p);
        if (pkgPath && fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          ver = typeof pkg.version === "string" ? pkg.version : undefined;
        }
      } catch { /* ignore version read errors */ }
      output.appendLine(`[Floe] Resolved LSP (${c.src}): ${c.p}${ver ? ` v${ver}` : ""}`);
      return { modulePath: c.p, source: c.src, version: ver };
    } else if (c.src === "custom") {
      output.appendLine(`[Floe] Custom languageServer.path not found: ${c.p}`);
    }
  }

  return null;
}

function resolvePackageJsonFor(entryPath: string): string | null {
  let dir = path.dirname(entryPath);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const j = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (j.name === "@fazelstudio/floe") return candidate;
      } catch { /* ignore */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getServerArgs(modulePath: string): string[] {
  const normalized = modulePath.replace(/\\/g, "/");
  if (normalized.endsWith("cli/main.js") || normalized.endsWith("cli\\main.js")) {
    return ["lsp", "--stdio"];
  }
  return [];
}

function getBundledVersion(context: vscode.ExtensionContext): string | undefined {
  try {
    const pkgPath = context.asAbsolutePath(path.join("node_modules", "@fazelstudio", "floe", "package.json"));
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return pkg.version;
    }
  } catch { /* ignore */ }
  return undefined;
}

class FloeErrorHandler implements ErrorHandler {
  constructor(private readonly output: vscode.OutputChannel) {}
  error(error: Error, _message: unknown, count: number | undefined): { action: ErrorAction } {
    this.output.appendLine(`[Floe] LSP error${count ? ` (#${count})` : ""}: ${error.message}`);
    if (count !== undefined && count > 3) {
      void vscode.window.showErrorMessage(`Floe language server error: ${error.message}. See Floe output for details.`);
      return { action: ErrorAction.Shutdown };
    }
    return { action: ErrorAction.Continue };
  }
  closed(): { action: CloseAction } {
    const now = Date.now();
    restartTimestamps.push(now);
    while (restartTimestamps.length > 0 && restartTimestamps[0]! < now - RESTART_WINDOW_MS) {
      restartTimestamps.shift();
    }
    restartCount++;
    this.output.appendLine(`[Floe] Language server exited (restart #${restartCount}, ${restartTimestamps.length} in window)`);
    if (restartTimestamps.length > MAX_RESTARTS) {
      void vscode.window.showErrorMessage(
        "Floe language server crashed repeatedly and will not be restarted. Check the 'Floe' output channel or run 'Floe: Restart Language Server'.",
        "Show Output"
      ).then((sel) => {
        if (sel === "Show Output") this.output.show(true);
      });
      return { action: CloseAction.DoNotRestart };
    }
    this.output.appendLine("[Floe] Restarting language server...");
    return { action: CloseAction.Restart };
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationStartTime = performance.now();
  outputChannel = vscode.window.createOutputChannel("Floe");
  outputChannel.appendLine("Floe extension activated.");
  context.subscriptions.push(outputChannel);

  // Track diagnostics latency: record time when floe document changes
  const changeTimeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId === "floe") {
      diagnosticChangeTimes.set(e.document.uri.toString(), performance.now());
    }
  });
  context.subscriptions.push(changeTimeDisposable);

  const openDisposable = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.languageId === "floe") {
      const activationTime = Math.round(performance.now() - activationStartTime);
      outputChannel!.appendLine(`[Floe] Opened Floe document: ${doc.uri.fsPath} (${doc.lineCount} lines, activation+open: ${activationTime}ms)`);
    }
  });
  context.subscriptions.push(openDisposable);

  // Register preview commands FIRST — must succeed even if later steps fail
  try {
    registerPreviewCommands(context, outputChannel);
    outputChannel.appendLine("[Floe] Preview commands registered: floe.openPreview, floe.showPreviewToSide, floe.refreshPreview");
  } catch (err) {
    outputChannel.appendLine(`[Floe] Failed to register preview commands: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    registerPreviewSync(context, outputChannel);
    outputChannel.appendLine("[Floe] Preview sync registered");
  } catch (err) {
    outputChannel.appendLine(`[Floe] Failed to register preview sync: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Register Custom Editor for native preview toggle (editor selector, Open With..., Set default)
  // Dynamic import so a failure here never prevents the basic preview commands above from working
  // This is additive and does not replace Floe: Open Preview (WebviewPanel) — both remain available
  try {
    const mod = await import("./preview/floeCustomEditor.js");
    const FloeCustomEditorProvider = (mod as any).FloeCustomEditorProvider;
    if (FloeCustomEditorProvider) {
      const customProvider = new FloeCustomEditorProvider(context, outputChannel);
      const customDisp = vscode.window.registerCustomEditorProvider("floe.previewEditor", customProvider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      });
      context.subscriptions.push(customDisp);
      outputChannel.appendLine("[Floe] Registered Custom Editor provider: floe.previewEditor (native toggle for .floe)");
    } else {
      outputChannel.appendLine("[Floe] Custom Editor provider not found in module");
    }
  } catch (err) {
    outputChannel.appendLine(`[Floe] Failed to register Custom Editor: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) outputChannel.appendLine(err.stack);
  }

  const config = vscode.workspace.getConfiguration("floe");
  const enabled = config.get<boolean>("languageServer.enabled", true);
  if (!enabled) {
    outputChannel.appendLine("[Floe] Language Server disabled via floe.languageServer.enabled = false (TextMate highlighting only).");
    const activationTime = Math.round(performance.now() - activationStartTime);
    outputChannel.appendLine(`[Floe] Extension activation completed in ${activationTime}ms (LSP disabled)`);
    return;
  }

  const resolved = resolveFloeServerPath(context, outputChannel);
  if (!resolved) {
    const msg =
      "Floe language server not found. Install @fazelstudio/floe@1.0.0 locally (bun add @fazelstudio/floe) or ensure the extension's bundled server is present. Diagnostics, completion and formatting will be unavailable (syntax highlighting remains).";
    outputChannel.appendLine(`[Floe] ERROR: ${msg}`);
    void vscode.window.showWarningMessage(msg, "Show Output").then((sel) => {
      if (sel === "Show Output") outputChannel!.show(true);
    });
    const activationTime = Math.round(performance.now() - activationStartTime);
    outputChannel.appendLine(`[Floe] Extension activation completed in ${activationTime}ms (LSP not found)`);
    return;
  }

  const args = getServerArgs(resolved.modulePath);
  const command = process.execPath;
  const execCommand = fs.existsSync(command) ? command : "node";

  const serverOptions: ServerOptions = {
    command: execCommand,
    args: [resolved.modulePath, ...args],
    transport: TransportKind.stdio,
    options: {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(resolved.modulePath),
      env: { ...process.env },
    },
  };

  outputChannel.appendLine(`[Floe] Starting LSP: ${execCommand} ${[resolved.modulePath, ...args].join(" ")} (source=${resolved.source})`);
  const lspStartTime = performance.now();

  const trace = config.get<string>("trace.server", "off");
  const traceValue = trace === "verbose" ? "verbose" : trace === "messages" ? "messages" : "off";

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "floe" },
      { scheme: "untitled", language: "floe" },
    ],
    synchronize: {},
    diagnosticCollectionName: "floe",
    outputChannel: outputChannel,
    traceOutputChannel: outputChannel,
    revealOutputChannelOn: 4,
    errorHandler: new FloeErrorHandler(outputChannel),
    initializationFailedHandler: (error) => {
      outputChannel!.appendLine(`[Floe] Server initialization failed: ${error.message}`);
      void vscode.window.showErrorMessage(
        `Floe language server failed to initialize: ${error.message}. See 'Floe' output.`,
        "Show Output"
      ).then((s) => { if (s === "Show Output") outputChannel!.show(true); });
      return false;
    },
    middleware: {
      handleDiagnostics: (uri, diagnostics, next) => {
        try {
          if (!Array.isArray(diagnostics)) {
            outputChannel!.appendLine(`[Floe] Warning: server sent malformed diagnostics for ${uri.toString()}`);
            return next(uri, []);
          }
          // Measure diagnostics latency from last change
          const key = uri.toString();
          const changeTime = diagnosticChangeTimes.get(key);
          if (changeTime !== undefined) {
            const latency = Math.round(performance.now() - changeTime);
            // Only log meaningful latencies (< 5s) to avoid stale entries after reload
            if (latency < 5000) {
              outputChannel!.appendLine(`[Floe] Diagnostics for ${path.basename(uri.fsPath)}: ${diagnostics.length} issues, latency ${latency}ms`);
            }
            // Keep entry for a bit, but clear after use to avoid re-logging on subsequent publish
            diagnosticChangeTimes.delete(key);
          } else if (diagnostics.length > 0) {
            // Initial open diagnostics
            outputChannel!.appendLine(`[Floe] Diagnostics for ${path.basename(uri.fsPath)}: ${diagnostics.length} issues (initial)`);
          }
          return next(uri, diagnostics);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          outputChannel!.appendLine(`[Floe] handleDiagnostics error: ${msg}`);
          return;
        }
      },
      // Formatting latency measurement — delegates to LSP formatter (no duplicate formatter)
      provideDocumentFormattingEdits: async (document, options, token, next) => {
        const start = performance.now();
        try {
          const edits = await next(document, options, token);
          const elapsed = Math.round(performance.now() - start);
          if (edits) {
            outputChannel!.appendLine(`[Floe] Formatting: ${edits.length} edits in ${elapsed}ms for ${path.basename(document.uri.fsPath)}`);
            if (elapsed > 800) {
              outputChannel!.appendLine(`[Floe] Formatting latency warning: ${elapsed}ms for ${document.uri.fsPath} — large file may need splitting`);
            }
          }
          return edits;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel!.appendLine(`[Floe] Formatting error: ${msg}`);
          return null;
        }
      },
      provideDocumentSymbols: async (document, token, next) => {
        const start = performance.now();
        try {
          const symbols: any = await next(document, token);
          const elapsed = Math.round(performance.now() - start);
          const count = Array.isArray(symbols) ? symbols.length : 0;
          outputChannel!.appendLine(`[Floe] Document symbols: ${count} symbols in ${elapsed}ms for ${path.basename(document.uri.fsPath)}`);
          return symbols;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel!.appendLine(`[Floe] Document symbols error: ${msg}`);
          return null;
        }
      },
      provideFoldingRanges: async (document, context, token, next) => {
        const start = performance.now();
        try {
          const ranges: any = await next(document, context, token);
          const elapsed = Math.round(performance.now() - start);
          const count = Array.isArray(ranges) ? ranges.length : 0;
          if (count > 0) {
            outputChannel!.appendLine(`[Floe] Folding ranges: ${count} ranges in ${elapsed}ms for ${path.basename(document.uri.fsPath)}`);
          }
          return ranges;
        } catch {
          return null;
        }
      },
    },
  };

  try {
    client = new LanguageClient("floe", "Floe Language Server", serverOptions, clientOptions);
    client.registerProposedFeatures?.();

    const disposableVersionCheck = client.onDidChangeState((e) => {
      if (e.newState === State.Running) {
        const lspStartupTime = Math.round(performance.now() - lspStartTime);
        try {
          const serverVersion: string | undefined = (client as unknown as { initializeResult?: { serverInfo?: { version?: string } } }).initializeResult?.serverInfo?.version;
          const bundledVersion = getBundledVersion(context) ?? resolved.version;
          outputChannel!.appendLine(`[Floe] LSP running. Server version: ${serverVersion ?? "unknown"}, bundled: ${bundledVersion ?? "unknown"}`);
          outputChannel!.appendLine(`[Floe] LSP startup time: ${lspStartupTime}ms`);
          if (serverVersion && bundledVersion && serverVersion !== bundledVersion) {
            const semverMajor = (v: string) => v.split(".")[0];
            if (semverMajor(serverVersion) !== semverMajor(bundledVersion)) {
              const warn = `Floe language server version mismatch: server ${serverVersion} vs bundled ${bundledVersion}. Consider updating @fazelstudio/floe to ${bundledVersion}.`;
              outputChannel!.appendLine(`[Floe] WARNING: ${warn}`);
              void vscode.window.showWarningMessage(warn);
            } else {
              outputChannel!.appendLine(`[Floe] Minor version difference between server (${serverVersion}) and bundled (${bundledVersion}) — compatible.`);
            }
          } else if (!serverVersion) {
            outputChannel!.appendLine("[Floe] Server did not advertise version — skipping version check.");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          outputChannel!.appendLine(`[Floe] Version check failed: ${msg}`);
        }
        // No manual provider registration needed — LSP client handles formatting/symbols/folding automatically via documentSelector.
        // This avoids duplicate parser/formatter and keeps extension as thin LSP client.
        outputChannel!.appendLine("[Floe] Language features ready: diagnostics, completion, hover, definition, references, rename, formatting, symbols, folding (via LSP).");
      }
    });

    context.subscriptions.push(disposableVersionCheck);

    if (traceValue !== "off") {
      outputChannel.appendLine(`[Floe] Trace enabled: ${traceValue}`);
      const traceEnumValue = traceValue === "verbose" ? Trace.Verbose : Trace.Messages;
      void client.setTrace(traceEnumValue).catch(() => {/* ignore */});
    }

    const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("floe.trace.server") && client) {
        const newTrace = vscode.workspace.getConfiguration("floe").get<string>("trace.server", "off");
        const t = newTrace === "verbose" ? "verbose" : newTrace === "messages" ? "messages" : "off";
        outputChannel!.appendLine(`[Floe] Trace configuration changed to ${t}`);
        const traceEnumValue = t === "verbose" ? Trace.Verbose : t === "messages" ? Trace.Messages : Trace.Off;
        void client!.setTrace(traceEnumValue);
      }
      if (e.affectsConfiguration("floe.languageServer.enabled") || e.affectsConfiguration("floe.languageServer.path")) {
        void vscode.window
          .showInformationMessage("Floe language server configuration changed. Reload window to apply?", "Reload")
          .then((sel) => {
            if (sel === "Reload") void vscode.commands.executeCommand("workbench.action.reloadWindow");
          });
      }
      if (e.affectsConfiguration("floe.preview.autoUpdate")) {
        const v = vscode.workspace.getConfiguration("floe").get<boolean>("preview.autoUpdate", true);
        outputChannel!.appendLine(`[Floe] Preview autoUpdate changed to ${v}`);
      }
    });
    context.subscriptions.push(configDisposable);

    const restartCmd = vscode.commands.registerCommand("floe.restartLanguageServer", async () => {
      outputChannel!.appendLine("[Floe] Restart requested by user.");
      if (!client) {
        void vscode.window.showInformationMessage("Floe language server is not running.");
        return;
      }
      try {
        await client.stop();
        restartTimestamps.length = 0;
        restartCount = 0;
        await client.start();
        outputChannel!.appendLine("[Floe] Restarted successfully.");
        void vscode.window.showInformationMessage("Floe language server restarted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel!.appendLine(`[Floe] Restart failed: ${msg}`);
        void vscode.window.showErrorMessage(`Failed to restart Floe server: ${msg}`);
      }
    });
    context.subscriptions.push(restartCmd);

    await client.start();
    outputChannel.appendLine("[Floe] Language client started.");
    context.subscriptions.push({
      dispose: () => {},
    });

    const activationTime = Math.round(performance.now() - activationStartTime);
    outputChannel.appendLine(`[Floe] Extension activation completed in ${activationTime}ms`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    outputChannel.appendLine(`[Floe] Failed to start language client: ${msg}`);
    if (stack) outputChannel.appendLine(stack);
    void vscode.window.showErrorMessage(
      `Failed to start Floe language server: ${msg}. See 'Floe' output for details.`,
      "Show Output"
    ).then((s) => {
      if (s === "Show Output") outputChannel!.show(true);
    });
    client = undefined;
  }
}

export async function deactivate(): Promise<void> {
  if (client) {
    try {
      await client.stop();
    } catch {
      /* ignore shutdown errors */
    } finally {
      client = undefined;
    }
  }
  disposeAllPreviews();
  if (outputChannel) {
    const stats = getPreviewStats();
    outputChannel.appendLine(`[Floe] Extension deactivated. Preview stats: ${stats.count} active previews, ${stats.renderCount} total renders.`);
  }
}
