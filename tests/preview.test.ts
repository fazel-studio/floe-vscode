import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd()), "..");

describe("Stage 3 — Floe Preview Security", () => {
  describe("CSP configuration", () => {
    it("previewManager.ts does not use eval or Function", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/new Function/);
    });

    it("webview HTML escaping is implemented", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/escapeXml/);
      expect(src).toMatch(/&amp;/);
      expect(src).toMatch(/&lt;/);
      expect(src).toMatch(/&gt;/);
    });

    it("no arbitrary script execution in previewManager", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).not.toMatch(/innerHTML\s*=/);
      expect(src).not.toMatch(/insertAdjacentHTML/);
    });
  });

  describe("Command registration", () => {
    it("floe.openPreview command exists in package.json", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
      const cmd = pkg.contributes.commands.find((c: any) => c.command === "floe.openPreview");
      expect(cmd).toBeDefined();
      expect(cmd.title).toMatch(/Preview/);
    });

    it("floe.refreshPreview command exists in package.json", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
      const cmd = pkg.contributes.commands.find((c: any) => c.command === "floe.refreshPreview");
      expect(cmd).toBeDefined();
      expect(cmd.title).toMatch(/Preview/);
    });
  });

  describe("Debouncing", () => {
    it("debounce constants are defined", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/PREVIEW_DEBOUNCE_MS/);
      expect(src).toMatch(/VALIDATION_DEBOUNCE_MS/);
    });
  });

  describe("Error handling", () => {
    it("renderErrorSvg function exists for invalid source", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/renderErrorSvg/);
    });

    it("lastValidSvg tracking exists for error recovery", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/lastValidSvg/);
    });
  });

  describe("Webview configuration", () => {
    it("enableScripts is false in webview options", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/enableScripts:\s*false/);
    });

    it("localResourceRoots is empty array (no external resources)", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/localResourceRoots:\s*\[\]/);
    });
  });

  describe("Floe renderer reuse", () => {
    it("uses dynamic import to load renderFloe from bundled or node_modules path", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/ensureRenderFloe/);
      expect(src).toMatch(/bundled.*@fazelstudio.*floe/);
      expect(src).toMatch(/renderFloe/);
    });

    it("does not implement its own parser", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).not.toMatch(/class.*Lexer/);
      expect(src).not.toMatch(/class.*Parser/);
      expect(src).not.toMatch(/function.*parseFloe/);
    });

    it("does not implement its own layout engine", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).not.toMatch(/class.*Layout/);
      expect(src).not.toMatch(/SimpleLayoutEngine/);
      expect(src).not.toMatch(/DagreLayoutEngine/);
    });
  });

  describe("Preview lifecycle", () => {
    it("disposeAllPreviews exists and cleans up", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/disposeAllPreviews/);
    });

    it("previewStates Map exists for tracking open previews", () => {
      const src = fs.readFileSync(path.join(ROOT, "src/preview/previewManager.ts"), "utf-8");
      expect(src).toMatch(/previewStates.*Map/);
    });
  });
});

describe("Stage 3 — Preview compilation", () => {
  it("previewManager.ts compiles without errors", () => {
    const distPath = path.join(ROOT, "dist/preview/previewManager.js");
    expect(fs.existsSync(distPath)).toBe(true);
    const js = fs.readFileSync(distPath, "utf-8");
    expect(js).toMatch(/function renderSource/);
    expect(js).toMatch(/function getWebviewHtml/);
  });

  it("extension.js imports previewManager", () => {
    const extPath = path.join(ROOT, "dist/extension.js");
    expect(fs.existsSync(extPath)).toBe(true);
    const js = fs.readFileSync(extPath, "utf-8");
    expect(js).toMatch(/previewManager/);
  });
});
