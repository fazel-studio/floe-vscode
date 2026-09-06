import * as vscode from "vscode";
import * as path from "node:path";
import {
  ensureRenderFloe,
  renderSource,
  getWebviewHtml,
  getPreviewId,
} from "./previewManager";

/**
 * Floe Custom Preview Editor
 * Provides native VS Code Custom Editor for .floe files.
 * - Appears in editor selector (Text Editor | Floe Preview) and Open With...
 * - Gives native toggle like markdown/svg preview
 * - Reuses existing Floe pipeline (no duplicate parser/layout/renderer)
 * - Same security: CSP strict, enableScripts:false, no eval, treat .floe as untrusted
 */
export class FloeCustomEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly customStates = new Map<string, {
    panel: vscode.WebviewPanel;
    document: vscode.TextDocument;
    debounceTimer?: NodeJS.Timeout;
    lastValidSvg?: string;
    renderCount: number;
  }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const previewId = getPreviewId(document.uri);
    const loaded = await ensureRenderFloe(this.context);
    if (!loaded) {
      this.output.appendLine("[Floe] Custom preview: renderer not loaded");
    }

    webviewPanel.webview.options = {
      enableScripts: false,
    };

    const state = {
      panel: webviewPanel,
      document,
      debounceTimer: undefined as NodeJS.Timeout | undefined,
      lastValidSvg: undefined as string | undefined,
      renderCount: 0,
    };
    this.customStates.set(previewId, state);

    const update = (doc: vscode.TextDocument, delayMs: number) => {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        const source = doc.getText();
        const { svg, isError, errorMessage, timings, sizes } = renderSource(source);
        const displaySvg = isError && state.lastValidSvg ? state.lastValidSvg : svg;
        const showBanner = isError && !!state.lastValidSvg;
        if (!isError) state.lastValidSvg = svg;
        state.renderCount++;
        const html = getWebviewHtml(displaySvg, path.basename(doc.uri.fsPath) || "Untitled", showBanner ? (errorMessage ?? "Invalid source") : undefined);
        try {
          webviewPanel.webview.html = html;
          const totalMs = timings?.totalMs ?? 0;
          this.output.appendLine(`[Floe] Custom preview updated: ${doc.uri.fsPath} (${state.renderCount} renders, ${Math.round(totalMs)}ms, nodes:${sizes?.nodeCount ?? 0} edges:${sizes?.edgeCount ?? 0})`);
        } catch (err) {
          this.output.appendLine(`[Floe] Custom preview update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (isError) this.output.appendLine(`[Floe] Custom preview error: ${errorMessage}`);
      }, delayMs);
    };

    // Initial render
    update(document, 0);

    // Theme changes
    const themeDisp = vscode.window.onDidChangeActiveColorTheme(() => {
      if (webviewPanel.visible) update(document, 0);
    });

    // Document changes (live updates, debounced)
    const changeDisp = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        const autoUpdate = vscode.workspace.getConfiguration("floe").get<boolean>("preview.autoUpdate", true);
        if (!autoUpdate) return;
        // update document reference
        state.document = e.document;
        update(e.document, 150);
      }
    });

    // Handle panel dispose
    webviewPanel.onDidDispose(() => {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      this.customStates.delete(previewId);
      themeDisp.dispose();
      changeDisp.dispose();
      this.output.appendLine(`[Floe] Custom preview closed for ${previewId}`);
    });

    // Reveal when visible again
    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) {
        const currentDoc = vscode.workspace.textDocuments.find(d => getPreviewId(d.uri) === previewId) ?? document;
        update(currentDoc, 0);
      }
    });

    this.output.appendLine(`[Floe] Custom preview opened for ${document.uri.fsPath}`);
  }
}
