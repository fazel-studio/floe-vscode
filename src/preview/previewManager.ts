import * as vscode from "vscode";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const PREVIEW_DEBOUNCE_MS = 150;
const VALIDATION_DEBOUNCE_MS = 300;
const EXTERNAL_CHANGE_DEBOUNCE_MS = 500;

interface DiagnosticLike {
  severity: string;
  code: string;
  message: string;
}

interface RenderResult {
  svg: string;
  isError: boolean;
  errorMessage?: string;
  timings?: { parseMs: number; layoutMs: number; renderMs: number; totalMs: number };
  sizes?: { svgLength: number; nodeCount: number; edgeCount: number };
  parseResult?: { diagnostics: DiagnosticLike[] };
}

export let renderFloeImpl: ((source: string, options?: any) => RenderResult) | null = null;

export async function ensureRenderFloe(context: vscode.ExtensionContext): Promise<boolean> {
  if (renderFloeImpl) return true;

  // Primary: package import (works via bun / node_modules)
  try {
    // @ts-ignore - dynamic import resolved at runtime via bun/node
    const mod = await import("@fazelstudio/floe/dist/src/pipeline.js");
    if ((mod as any).renderFloe) {
      renderFloeImpl = (mod as any).renderFloe as (source: string, options?: any) => RenderResult;
      return true;
    }
  } catch { /* try next */ }

  try {
    // @ts-ignore - package subpath export
    const mod2 = await import("@fazelstudio/floe/pipeline");
    if ((mod2 as any).renderFloe) {
      renderFloeImpl = (mod2 as any).renderFloe as (source: string) => RenderResult;
      return true;
    }
  } catch { /* try fallback */ }

  const possiblePaths = [
    context.asAbsolutePath(path.join("bundled", "@fazelstudio", "floe", "dist", "src", "pipeline.js")),
    context.asAbsolutePath(path.join("node_modules", "@fazelstudio", "floe", "dist", "src", "pipeline.js")),
  ];

  for (const p of possiblePaths) {
    try {
      const url = pathToFileURL(p).href;
      const mod = await import(url);
      if ((mod as any).renderFloe) {
        renderFloeImpl = (mod as any).renderFloe as (source: string) => RenderResult;
        return true;
      }
    } catch { /* try next path */ }
  }
  return false;
}

interface PreviewState {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  uri: vscode.Uri;
  debounceTimer: NodeJS.Timeout | undefined;
  lastValidSvg: string | undefined;
  isErrorState: boolean;
  lastRenderTime?: number;
  renderCount: number;
}

const previewStates = new Map<string, PreviewState>();

export function getPreviewId(uri: vscode.Uri): string {
  return uri.toString();
}

export function renderSource(source: string): { svg: string; isError: boolean; errorMessage?: string; timings?: { parseMs: number; layoutMs: number; renderMs: number; totalMs: number }; sizes?: { svgLength: number; nodeCount: number; edgeCount: number } } {
  if (!renderFloeImpl) {
    return { svg: renderErrorSvg([], "Floe renderer not loaded"), isError: true, errorMessage: "Renderer not available" };
  }
  try {
    const result = renderFloeImpl(source, {
      svgOptions: { padding: 32 }
    });
    const hasErrors = result.parseResult?.diagnostics.some((d: DiagnosticLike) => d.severity === "error");
    if (hasErrors) {
      return {
        svg: renderErrorSvg(result.parseResult?.diagnostics ?? []),
        isError: true,
        errorMessage: "Parse errors in source",
        timings: result.timings,
        sizes: (result as any).sizes
      };
    }
    return { svg: result.svg, isError: false, timings: result.timings, sizes: (result as any).sizes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { svg: renderErrorSvg([], msg), isError: true, errorMessage: msg };
  }
}

export function renderErrorSvg(diagnostics: Array<{ message: string; code: string }>, extra?: string): string {
  // Show at most 5 errors to keep SVG readable; limit dy calculation without relying on indexOf for duplicates
  const errorDiags = diagnostics.filter(d => d.code.startsWith("E")).slice(0, 5);
  const errors = errorDiags
    .map((d, idx) => `<tspan x="16" dy="${idx === 0 ? 0 : 18}">${escapeXml(d.message)}</tspan>`)
    .join("");

  const hasErrors = errorDiags.length > 0;
  const extraLines = extra ? `<tspan x="16" dy="${hasErrors ? 18 : 0}">${escapeXml(String(extra))}</tspan>` : "";
  const hint = !hasErrors && !extra ? `<tspan x="16" dy="18" class="hint">Check syntax: direction, groups, node identifiers, or edge labels may be malformed.</tspan>` : "";

  // Use accessible high-contrast colors: dark red on light pink, with sufficient contrast ratio > 4.5:1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220" role="img" aria-label="Preview Error">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; fill: #b91c1c; }
    .hint { fill: #6b7280; font-size: 11px; }
    .title { font-weight: 600; font-size: 14px; fill: #7f1d1d; }
  </style>
  <rect width="100%" height="100%" fill="#fef2f2" stroke="#fecaca" stroke-width="1" rx="6"/>
  <text x="16" y="28" class="title">Preview Error</text>
  <text x="16" y="50">${errors}${extraLines}${hint}</text>
</svg>`;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function getThemeAwareStyles(isDark: boolean, isHighContrast: boolean): { bg: string; fg: string; containerBg: string } {
  if (isHighContrast) {
    return { bg: "#000000", fg: "#ffffff", containerBg: "#000000" };
  }
  if (isDark) {
    return { bg: "#1e1e1e", fg: "#d4d4d4", containerBg: "#252526" };
  }
  return { bg: "#ffffff", fg: "#1f2937", containerBg: "#ffffff" };
}

export function getWebviewHtml(svg: string, title: string, errorMessage?: string): string {
  // Theme-aware HTML: respect VS Code theme for sufficient contrast and accessibility
  // Also support VS Code CSS variables fallback for webview theme injection
  let isDark = false;
  let isHighContrast = false;
  try {
    const kind = (vscode.window.activeColorTheme?.kind) ?? 1;
    // ColorThemeKind: Light=1, Dark=2, HighContrast=3, HighContrastLight=4
    isDark = kind === 2;
    isHighContrast = kind === 3 || kind === 4;
  } catch { /* fallback to light */ }

  const theme = getThemeAwareStyles(isDark, isHighContrast);

  const errorBanner = errorMessage
    ? `<div class="error-banner" role="alert" aria-live="assertive">⚠ ${escapeXml(errorMessage)} — showing last valid preview</div>`
    : "";
  const errorStyle = errorMessage
    ? `.error-banner { position:absolute; top:0; left:0; right:0; background:#fef2f2; color:#7f1d1d; border-bottom:1px solid #fecaca; padding:8px 12px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:12px; line-height:1.4; } .error-banner::before { content:""; } .container { padding-top:36px; }`
    : "";
  // High-contrast mode adjustments
  const hcStyle = isHighContrast ? `html, body { background: ${theme.bg} !important; color: ${theme.fg} !important; } .container { background: ${theme.containerBg}; }` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none';">
  <meta name="color-scheme" content="${isDark ? "dark" : "light"}">
  <title>${escapeXml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background, ${theme.bg}); color: var(--vscode-editor-foreground, ${theme.fg}); }
    .container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow:auto; background: var(--vscode-editor-background, ${theme.containerBg}); padding: 16px; }
    .container:focus { outline: 2px solid var(--vscode-focusBorder, #007acc); outline-offset: -2px; }
    /* Ensure diagram text has sufficient contrast even on themed background */
    .node text, .edge-label text { /* Removed forced fill, use SVG's inline color */ }
    
    /* Auto-invert for dark mode */
    :root { --svg-filter: none; }
    @media (prefers-color-scheme: dark) {
      :root { --svg-filter: invert(0.93) hue-rotate(180deg); }
    }
    body.vscode-light { --svg-filter: none !important; }
    body.vscode-dark { --svg-filter: invert(0.93) hue-rotate(180deg) !important; }
    body.vscode-high-contrast { --svg-filter: invert(1) grayscale(1) !important; }
    svg { 
      max-width: 100%; 
      max-height: 100%; 
      display: block; 
      filter: var(--svg-filter); 
    }
    
    ${errorStyle}
    ${hcStyle}
  </style>
</head>
<body>
  ${errorBanner}
  <div class="container" id="container" role="img" aria-label="${escapeXml(title)} diagram preview" tabindex="0">${svg}</div>
</body>
</html>`;
}

function createOrUpdatePreview(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  output: vscode.OutputChannel,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
): void {
  const previewId = getPreviewId(document.uri);
  const state = previewStates.get(previewId);

  if (state && state.panel) {
    // Update existing preview's document reference to latest version (handles external changes)
    state.document = document;
    state.uri = document.uri;
    scheduleUpdate(state, document, output, PREVIEW_DEBOUNCE_MS);
    // Reveal existing panel without stealing focus
    try { state.panel.reveal(viewColumn, true); } catch { /* ignore */ }
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "floe.preview",
    `Floe: ${path.basename(document.uri.fsPath) || "Untitled"}`,
    { viewColumn: viewColumn, preserveFocus: true },
    {
      enableScripts: false,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    }
  );

  const newState: PreviewState = {
    panel,
    document,
    uri: document.uri,
    debounceTimer: undefined,
    lastValidSvg: undefined,
    isErrorState: false,
    renderCount: 0,
  };

  previewStates.set(previewId, newState);

  panel.onDidDispose(() => {
    const s = previewStates.get(previewId);
    if (s?.debounceTimer) clearTimeout(s.debounceTimer);
    // Use current map key (may have been updated after rename) — delete by panel identity
    for (const [key, val] of previewStates.entries()) {
      if (val.panel === panel) {
        previewStates.delete(key);
        break;
      }
    }
    output.appendLine(`[Floe] Preview closed for ${previewId}`);
  });

  panel.onDidChangeViewState(() => {
    const s = previewStates.get(previewId);
    if (s && panel.visible) {
      // Re-render with current document content when becoming visible (avoids stale after reload/switch)
      const currentDoc = vscode.workspace.textDocuments.find(d => getPreviewId(d.uri) === previewId) ?? document;
      // Also try to resolve from uri directly for external changes when doc not in textDocuments (e.g., after reload)
      if (currentDoc) {
        scheduleUpdate(s, currentDoc, output, 0);
      } else {
        // Try to load from disk for external file if no open document
        void vscode.workspace.openTextDocument(document.uri).then(
          (doc) => scheduleUpdate(s, doc, output, 0),
          () => output.appendLine(`[Floe] Could not restore preview for ${previewId}: document not available`)
        );
      }
    }
  });

  scheduleUpdate(newState, document, output, 0);
  output.appendLine(`[Floe] Preview opened for ${document.uri.fsPath || document.uri.toString()}`);
}

// Unified scheduler to avoid duplicate debounce logic
function scheduleUpdate(state: PreviewState, document: vscode.TextDocument, output: vscode.OutputChannel, delayMs: number): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    const startTime = performance.now();
    const source = document.getText();
    const { svg, isError, errorMessage, timings, sizes } = renderSource(source);
    const renderTime = performance.now() - startTime;

    state.lastRenderTime = renderTime;
    state.renderCount++;
    if (!isError) {
      state.lastValidSvg = svg;
    }
    state.isErrorState = isError;

    const displaySvg = isError && state.lastValidSvg ? state.lastValidSvg : svg;
    const showBanner = isError && !!state.lastValidSvg;
    const html = getWebviewHtml(displaySvg, path.basename(document.uri.fsPath) || "Untitled", showBanner ? (errorMessage ?? "Invalid source") : undefined);

    try {
      state.panel.webview.html = html;
      const totalMs = timings?.totalMs ?? renderTime;
      const nodeCount = sizes?.nodeCount ?? 0;
      const edgeCount = sizes?.edgeCount ?? 0;
      output.appendLine(`[Floe] Preview updated: ${document.uri.fsPath || document.uri.toString()} (${state.renderCount} renders, last: ${Math.round(totalMs)}ms total, parse:${timings?.parseMs ?? "?"}ms layout:${timings?.layoutMs ?? "?"}ms render:${timings?.renderMs ?? "?"}ms${nodeCount ? `, nodes:${nodeCount} edges:${edgeCount}` : ""})`);
      // Performance warning for large diagrams
      if (nodeCount > 500 || totalMs > 800) {
        output.appendLine(`[Floe] Performance note: Large diagram (${nodeCount} nodes, ${edgeCount} edges) rendered in ${Math.round(totalMs)}ms. Consider splitting into smaller groups if editing feels slow.`);
      } else if (totalMs > 500) {
        output.appendLine(`[Floe] Preview render took ${Math.round(totalMs)}ms — large diagram may benefit from smaller groups.`);
      }
    } catch (err) {
      output.appendLine(`[Floe] Webview update failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (isError) {
      output.appendLine(`[Floe] Preview render had errors: ${errorMessage}`);
    }
  }, delayMs);
}

function updatePreview(state: PreviewState, document: vscode.TextDocument, output: vscode.OutputChannel): void {
  scheduleUpdate(state, document, output, PREVIEW_DEBOUNCE_MS);
}

function debouncedRefresh(previewId: string, document: vscode.TextDocument, output: vscode.OutputChannel): void {
  const state = previewStates.get(previewId);
  if (!state) return;
  const autoUpdate = vscode.workspace.getConfiguration("floe").get<boolean>("preview.autoUpdate", true);
  if (!autoUpdate) return;

  // Use unified scheduler with validation debounce (slightly longer to batch rapid typing)
  state.document = document;
  scheduleUpdate(state, document, output, VALIDATION_DEBOUNCE_MS);
}

function refreshPreviewForUri(uri: vscode.Uri, output: vscode.OutputChannel): void {
  const previewId = getPreviewId(uri);
  const state = previewStates.get(previewId);
  if (!state) return;

  const autoUpdate = vscode.workspace.getConfiguration("floe").get<boolean>("preview.autoUpdate", true);
  if (!autoUpdate) return;

  // Try to find current document; if not open, attempt to read file directly for external change
  const doc = vscode.workspace.textDocuments.find(d => getPreviewId(d.uri) === previewId);
  if (doc) {
    if (doc.languageId !== "floe") return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.document = doc;
    scheduleUpdate(state, doc, output, EXTERNAL_CHANGE_DEBOUNCE_MS);
    return;
  }
  // External change where document not open: read from disk if file exists
  void vscode.workspace.openTextDocument(uri).then(
    (opened) => {
      if (opened.languageId !== "floe") return;
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.document = opened;
      state.uri = uri;
      scheduleUpdate(state, opened, output, EXTERNAL_CHANGE_DEBOUNCE_MS);
    },
    () => {
      // File may have been deleted or not yet available — log and keep last valid
      output.appendLine(`[Floe] External change detected but document not open for ${uri.fsPath}`);
    }
  );
}

export function openPreview(context: vscode.ExtensionContext, output: vscode.OutputChannel, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("No active .floe document to preview.");
    return;
  }

  const doc = editor.document;
  if (doc.languageId !== "floe") {
    void vscode.window.showInformationMessage("Active document is not a .floe file.");
    return;
  }

  void ensureRenderFloe(context).then((loaded) => {
    if (!loaded) {
      void vscode.window.showWarningMessage("Floe renderer could not be loaded. Preview may not work correctly. Check that @fazelstudio/floe is installed.");
    }
    createOrUpdatePreview(context, doc, output, viewColumn);
  });
}

export function registerPreviewCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const cmd = vscode.commands.registerCommand("floe.openPreview", () => {
    openPreview(context, output, vscode.ViewColumn.Active);
  });
  context.subscriptions.push(cmd);

  // Alt command for editor/title split (markdown-style)
  const toSideCmd = vscode.commands.registerCommand("floe.showPreviewToSide", () => {
    openPreview(context, output, vscode.ViewColumn.Beside);
  });
  context.subscriptions.push(toSideCmd);

  const refreshCmd = vscode.commands.registerCommand("floe.refreshPreview", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "floe") {
      void vscode.window.showInformationMessage("No active .floe document to refresh.");
      return;
    }
    const previewId = getPreviewId(editor.document.uri);
    const state = previewStates.get(previewId);
    if (state) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      scheduleUpdate(state, editor.document, output, 0);
      output.appendLine(`[Floe] Manual preview refresh for ${editor.document.uri.fsPath}`);
    } else {
      // No preview yet — open one (still respects that refresh should open if needed)
      void ensureRenderFloe(context).then(() => createOrUpdatePreview(context, editor.document, output));
    }
  });
  context.subscriptions.push(refreshCmd);
}

export function registerPreviewSync(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): void {
  // Register serializer to restore preview after workspace/window reload
  try {
    const serializer = vscode.window.registerWebviewPanelSerializer("floe.preview", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        // state is not persisted by us (since enableScripts false), so we attempt best-effort restoration
        // Use panel title to find matching document: "Floe: basename"
        const title = panel.title ?? "";
        const basename = title.replace(/^Floe:\s*/, "");
        output.appendLine(`[Floe] Deserializing preview panel: ${title} (state: ${JSON.stringify(state)})`);
        // Enable retention and set placeholder while searching for document
        panel.webview.options = { enableScripts: false };
        // Try to find document by basename among open floe documents
        const candidates = vscode.workspace.textDocuments.filter(d => d.languageId === "floe" && path.basename(d.uri.fsPath) === basename);
        if (candidates.length === 1 && candidates[0]) {
          const doc = candidates[0];
          const previewId = getPreviewId(doc.uri);
          const newState: PreviewState = {
            panel,
            document: doc,
            uri: doc.uri,
            debounceTimer: undefined,
            lastValidSvg: undefined,
            isErrorState: false,
            renderCount: 0,
          };
          previewStates.set(previewId, newState);
          panel.onDidDispose(() => {
            for (const [key, val] of previewStates.entries()) {
              if (val.panel === panel) { previewStates.delete(key); break; }
            }
          });
          panel.onDidChangeViewState(() => {
            if (panel.visible) {
              const currentDoc = vscode.workspace.textDocuments.find(d => getPreviewId(d.uri) === previewId) ?? doc;
              scheduleUpdate(newState, currentDoc, output, 0);
            }
          });
          void ensureRenderFloe(context).then(() => scheduleUpdate(newState, doc, output, 0));
          output.appendLine(`[Floe] Restored preview for ${doc.uri.fsPath} after reload`);
        } else if (candidates.length > 1) {
          output.appendLine(`[Floe] Multiple candidates for preview restore: ${basename} — waiting for user to open preview manually`);
          panel.dispose();
        } else {
          output.appendLine(`[Floe] No open document found for preview restore: ${basename} — disposing restored panel`);
          // Keep panel but show placeholder message
          panel.webview.html = getWebviewHtml(renderErrorSvg([], `No open document found for "${basename}". Open the file and run "Floe: Open Preview" again.`), basename);
        }
      }
    });
    context.subscriptions.push(serializer);
    output.appendLine("[Floe] Registered preview panel serializer for reload handling");
  } catch (err) {
    output.appendLine(`[Floe] Failed to register preview serializer: ${err instanceof Error ? err.message : String(err)}`);
  }

  const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    const doc = event.document;
    if (doc.languageId !== "floe") return;

    const previewId = getPreviewId(doc.uri);
    const state = previewStates.get(previewId);
    if (state) {
      debouncedRefresh(previewId, doc, output);
    }
  });
  context.subscriptions.push(changeDisposable);

  // Track active editor changes to avoid stale preview logs (no auto-switch of per-doc preview)
  const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor || editor.document.languageId !== "floe") return;
    const doc = editor.document;
    const previewId = getPreviewId(doc.uri);
    const hasPreview = previewStates.has(previewId);
    output.appendLine(`[Floe] Active editor changed: ${doc.uri.fsPath} (${doc.lineCount} lines) — preview ${hasPreview ? "exists" : "not open"}`);
    // Do not auto-switch preview content; per-doc preview remains pinned to its document
  });
  context.subscriptions.push(activeEditorDisposable);

  const saveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.languageId !== "floe") return;
    const previewId = getPreviewId(doc.uri);
    const state = previewStates.get(previewId);
    if (state) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      // Save should update preview even if autoUpdate is false? We treat save as explicit, but we also respect autoUpdate for externalWatcher.
      // For reliability after save, always schedule immediate update (user expects preview to reflect saved file)
      state.document = doc;
      scheduleUpdate(state, doc, output, 0);
      output.appendLine(`[Floe] Preview updated after save: ${doc.uri.fsPath}`);
    }
  });
  context.subscriptions.push(saveDisposable);

  const closeDisposable = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.languageId !== "floe") return;
    const previewId = getPreviewId(doc.uri);
    const state = previewStates.get(previewId);
    if (state) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      // Keep preview open even if source closed? For daily workflow, we dispose to avoid orphan panels
      // But we log gracefully and dispose
      state.panel.dispose();
      // dispose will clean map via onDidDispose
    }
  });
  context.subscriptions.push(closeDisposable);

  const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
    for (const file of event.files) {
      const oldPath = file.oldUri.fsPath;
      const newPath = file.newUri.fsPath;
      const isFloeFile = oldPath.endsWith(".floe") || newPath.endsWith(".floe");
      // Handle direct file rename and directory rename (prefix match)
      for (const [previewId, state] of Array.from(previewStates.entries())) {
        const previewFsPath = state.uri.fsPath;
        const isMatch = previewFsPath === oldPath || previewFsPath.startsWith(oldPath + path.sep);
        const isDirectFloe = previewId === getPreviewId(file.oldUri);
        if (isDirectFloe || (isFloeFile && isMatch)) {
          const newUri = isDirectFloe ? file.newUri : vscode.Uri.file(previewFsPath.replace(oldPath, newPath));
          const newPreviewId = getPreviewId(newUri);
          previewStates.delete(previewId);
          state.panel.title = `Floe: ${path.basename(newUri.fsPath) || "Untitled"}`;
          state.uri = newUri;
          // Update document reference if new document is open
          const newDoc = vscode.workspace.textDocuments.find(d => getPreviewId(d.uri) === newPreviewId);
          if (newDoc) state.document = newDoc;
          previewStates.set(newPreviewId, state);
          output.appendLine(`[Floe] Preview remapped for rename: ${oldPath} -> ${newUri.fsPath}`);
          if (newDoc) {
            scheduleUpdate(state, newDoc, output, 0);
          } else {
            // Try to open new file to render
            void vscode.workspace.openTextDocument(newUri).then(
              (doc) => { state.document = doc; scheduleUpdate(state, doc, output, 0); },
              () => output.appendLine(`[Floe] Renamed file not yet open: ${newUri.fsPath}`)
            );
          }
        }
      }
    }
  });
  context.subscriptions.push(renameDisposable);

  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.floe");
  context.subscriptions.push(fileWatcher);

  fileWatcher.onDidChange((uri) => {
    output.appendLine(`[Floe] External file change detected: ${uri.fsPath}`);
    refreshPreviewForUri(uri, output);
  });
  fileWatcher.onDidCreate((uri) => {
    output.appendLine(`[Floe] External file created: ${uri.fsPath}`);
    refreshPreviewForUri(uri, output);
  });
  fileWatcher.onDidDelete((uri) => {
    output.appendLine(`[Floe] External file deleted: ${uri.fsPath}`);
    const previewId = getPreviewId(uri);
    const state = previewStates.get(previewId);
    if (state) {
      // Keep last valid preview but show error banner that file is deleted
      const html = getWebviewHtml(state.lastValidSvg ?? renderErrorSvg([], "File deleted"), path.basename(uri.fsPath), "File deleted — showing last valid preview");
      try { state.panel.webview.html = html; } catch { /* ignore */ }
      output.appendLine(`[Floe] Preview retained last valid for deleted file: ${uri.fsPath}`);
    }
  });
  context.subscriptions.push({
    dispose: () => fileWatcher.dispose()
  });

  // Handle theme changes to re-render preview with correct contrast
  const themeChangeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
    output.appendLine("[Floe] Color theme changed — refreshing visible previews");
    for (const state of previewStates.values()) {
      if (state.panel.visible) {
        scheduleUpdate(state, state.document, output, 0);
      }
    }
  });
  context.subscriptions.push(themeChangeDisposable);
}

export function disposeAllPreviews(): void {
  for (const [id, state] of previewStates) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    try { state.panel.dispose(); } catch { /* ignore */ }
    previewStates.delete(id);
  }
}

export function __resetPreviewForTests(): void {
  disposeAllPreviews();
}

export function getPreviewStats(): { count: number; renderCount: number } {
  let totalRenders = 0;
  for (const state of previewStates.values()) {
    totalRenders += state.renderCount;
  }
  return { count: previewStates.size, renderCount: totalRenders };
}
