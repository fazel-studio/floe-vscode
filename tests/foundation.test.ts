import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd()), "..");

function readJson(rel: string): any {
  const full = path.join(ROOT, rel);
  const raw = fs.readFileSync(full, "utf-8");
  return JSON.parse(raw);
}

describe("Stage 1 — Foundation: package.json registration", () => {
  it("registers .floe with languageId floe and onLanguage activation", () => {
    const pkg = readJson("package.json");
    expect(pkg.name).toBeTruthy();
    expect(pkg.engines?.vscode).toBeTruthy();
    expect(pkg.activationEvents).toContain("onLanguage:floe");
    expect(pkg.contributes).toBeDefined();
    const languages = pkg.contributes.languages;
    expect(Array.isArray(languages)).toBe(true);
    const floe = languages.find((l: any) => l.id === "floe");
    expect(floe).toBeDefined();
    expect(floe.extensions).toContain(".floe");
    expect(floe.configuration).toMatch(/language-configuration\.json/);
    // icon paths exist as strings
    expect(floe.icon).toBeDefined();
    expect(floe.icon.light).toMatch(/floe-light\.svg/);
    expect(floe.icon.dark).toMatch(/floe\.svg/);
    // marketplace icon
    expect(pkg.icon).toMatch(/floe-icon\.png/);
    expect(fs.existsSync(path.join(ROOT, pkg.icon))).toBe(true);
  });

  it("registers TextMate grammar for source.floe", () => {
    const pkg = readJson("package.json");
    const grammars = pkg.contributes.grammars;
    expect(Array.isArray(grammars)).toBe(true);
    const g = grammars.find((gr: any) => gr.language === "floe");
    expect(g).toBeDefined();
    expect(g.scopeName).toBe("source.floe");
    expect(g.path).toBe("./syntaxes/floe.tmLanguage.json");
    expect(fs.existsSync(path.join(ROOT, "syntaxes/floe.tmLanguage.json"))).toBe(true);
  });

  it("registers floe.openPreview command (Stage 3)", () => {
    const pkg = readJson("package.json");
    const commands = pkg.contributes?.commands ?? [];
    const preview = commands.find((c: any) => c.command === "floe.openPreview");
    expect(preview).toBeDefined();
    expect(preview.title).toMatch(/Preview/);
    expect(preview.category).toBe("Floe");
  });

  it("has correct publisher, category, and main entry", () => {
    const pkg = readJson("package.json");
    expect(pkg.publisher).toBeTruthy();
    expect(pkg.categories).toContain("Programming Languages");
    expect(pkg.main).toBe("./dist/extension.js");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("depends on @fazelstudio/floe via bundled LSP (Stage 2) — no duplicate parser", () => {
    const pkg = readJson("package.json");
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    // Stage 2: extension must bundle/resolve @fazelstudio/floe for LSP, but must NOT create second parser
    const floeVersion = allDeps["@fazelstudio/floe"] ?? pkg.dependencies?.["@fazelstudio/floe"];
    expect(floeVersion).toBeDefined();
    // must be satisfiable for 1.0.x (allow file:../floe or ^1.0.x etc) - supports bun
    expect(String(floeVersion)).toMatch(/1\.0\.\d+|file:/);
    // Also requires vscode-languageclient for LSP integration
    expect(allDeps["vscode-languageclient"]).toBeDefined();
  });
});

describe("language-configuration.json", () => {
  let cfg: any;
  beforeAll(() => {
    cfg = readJson("language-configuration.json");
  });

  it("defines // lineComment", () => {
    expect(cfg.comments?.lineComment).toBe("//");
  });

  it("defines brackets for { } [ ] and quotes", () => {
    const brackets = cfg.brackets as [string, string][];
    expect(brackets).toEqual(expect.arrayContaining([["{", "}"], ["[", "]"]]));
    // string bracket is optional but should be present
    const hasQuote = brackets.some(([a, b]) => a === '"' && b === '"');
    expect(hasQuote).toBe(true);
  });

  it("defines autoClosing and surrounding pairs", () => {
    expect(Array.isArray(cfg.autoClosingPairs)).toBe(true);
    expect(cfg.autoClosingPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ open: "{", close: "}" }),
        expect.objectContaining({ open: "[", close: "]" }),
        expect.objectContaining({ open: '"', close: '"' }),
      ])
    );
    expect(Array.isArray(cfg.surroundingPairs)).toBe(true);
  });

  it("defines wordPattern for Floe identifiers [A-Za-z_][A-Za-z0-9_-]*", () => {
    expect(cfg.wordPattern).toBeTruthy();
    const re = new RegExp(cfg.wordPattern);
    // valid
    expect(re.test("User")).toBe(true);
    expect(re.test("_valid")).toBe(true);
    expect(re.test("my-node")).toBe(true);
    expect(re.test("API_2")).toBe(true);
    // wordPattern is used for double-click selection; ensure it matches identifiers inside larger text
    const text = "User [person] -> API";
    const matches = text.match(new RegExp(cfg.wordPattern, "g"));
    expect(matches).toEqual(expect.arrayContaining(["User", "person", "API"]));
  });

  it("defines indentation rules for group { }", () => {
    expect(cfg.indentationRules).toBeDefined();
    expect(cfg.indentationRules.increaseIndentPattern).toMatch(/\{/);
    expect(cfg.indentationRules.decreaseIndentPattern).toMatch(/}/);
    expect(Array.isArray(cfg.onEnterRules)).toBe(true);
  });
});

describe("syntaxes/floe.tmLanguage.json — TextMate grammar", () => {
  let grammar: any;
  let rawText: string;

  beforeAll(() => {
    const p = path.join(ROOT, "syntaxes/floe.tmLanguage.json");
    rawText = fs.readFileSync(p, "utf-8");
    grammar = JSON.parse(rawText);
  });

  it("is valid JSON with scopeName source.floe", () => {
    expect(grammar.scopeName).toBe("source.floe");
    expect(grammar.name).toMatch(/Floe/i);
    expect(Array.isArray(grammar.patterns)).toBe(true);
    expect(grammar.repository).toBeDefined();
  });

  it("covers required repository patterns", () => {
    const repo = grammar.repository;
    const required = [
      "comments",
      "strings",
      "directionStatement",
      "groupStatement",
      "metaStatement",
      "noteStatement",
      "linkStatement",
      "edgeStatement",
      "nodeStatement",
      "keywords",
      "operators",
      "punctuation",
    ];
    for (const key of required) {
      expect(repo[key], `missing repository key: ${key}`).toBeDefined();
    }
  });

  it("highlights comments //", () => {
    expect(grammar.repository.comments.match).toMatch(/\/\//);
    expect(grammar.repository.comments.name).toMatch(/comment/);
    // verify patterns order: comments first
    const first = grammar.patterns[0];
    expect(first.include).toBe("#comments");
  });

  it("highlights strings with escapes", () => {
    const s = grammar.repository.strings;
    expect(s.begin).toBe('"');
    expect(s.end).toBe('"');
    const esc = s.patterns?.find((p: any) => p.match?.includes("\\\\"));
    expect(esc).toBeDefined();
  });

  it("highlights direction declaration", () => {
    const dir = grammar.repository.directionStatement;
    expect(dir.match).toMatch(/direction/);
    expect(dir.match).toMatch(/TB\|BT\|LR\|RL/);
    expect(dir.captures["1"].name).toMatch(/keyword/);
    expect(dir.captures["2"].name).toMatch(/direction/);
  });

  it("highlights group syntax with braces", () => {
    const g = grammar.repository.groupStatement;
    expect(g.begin).toMatch(/group/);
    expect(g.begin).toMatch(/A-Za-z/);
    // should handle type brackets and braces in patterns
    const hasBracket = g.patterns.some((p: any) => p.match?.includes("\\["));
    expect(hasBracket).toBe(true);
    const hasBrace = g.patterns.some((p: any) => p.match?.includes("\\{"));
    expect(hasBrace).toBe(true);
    expect(g.beginCaptures["1"].name).toMatch(/keyword/);
  });

  it("highlights node type declarations [type]", () => {
    const node = grammar.repository.nodeStatement;
    expect(node.match ?? JSON.stringify(node.patterns)).toMatch(/A-Za-z/);
    // should contain entity.name.type scope
    const hasTypeScope =
      JSON.stringify(node).includes("entity.name.type") ||
      JSON.stringify(grammar.repository.groupStatement).includes("entity.name.type");
    expect(hasTypeScope).toBe(true);
  });

  it("highlights edge operators -> and -- and colon label", () => {
    const edge = grammar.repository.edgeStatement;
    // edgeStatement uses begin for source -> target and inner label with :
    const edgeStr = JSON.stringify(edge);
    expect(edgeStr).toMatch(/->/);
    expect(edgeStr).toMatch(/--/);
    expect(edgeStr).toMatch(/:/);
    expect(edge.beginCaptures["2"].name).toMatch(/operator/);
  });

  it("highlights meta/note/link keywords", () => {
    const kw = grammar.repository.keywords;
    expect(kw.match).toMatch(/meta/);
    expect(kw.match).toMatch(/note/);
    expect(kw.match).toMatch(/link/);
    expect(kw.match).toMatch(/group/);
    expect(kw.match).toMatch(/direction/);
  });

  it("highlights braces/brackets and operators", () => {
    expect(grammar.repository.operators.match).toMatch(/->/);
    expect(grammar.repository.punctuation.match).toMatch(/\{/);
    expect(grammar.repository.punctuation.match).toMatch(/\[/);
  });

  it("covers edge labels (quoted and unquoted)", () => {
    const edge = grammar.repository.edgeStatement;
    const edgeStr = JSON.stringify(edge);
    // edge label inner should include strings (via #strings include) and unquoted label
    expect(edgeStr).toMatch(/#strings|string\.quoted/);
    expect(edgeStr).toMatch(/label/);
  });

  it("is valid TextMate JSON (no trailing commas, valid $schema)", () => {
    expect(grammar.$schema).toMatch(/tmlanguage\.json/);
    // ensure file is parseable and not empty
    expect(rawText.length).toBeGreaterThan(500);
  });

  // Representative sampling via regex tests that mirror grammar behavior
  it("representative sample: direction LR matches grammar", () => {
    const dirRe = new RegExp(grammar.repository.directionStatement.match);
    expect(dirRe.test("direction LR")).toBe(true);
    expect(dirRe.test("direction TB")).toBe(true);
    expect(dirRe.test("direction RL")).toBe(true);
    expect(dirRe.test("direction XX")).toBe(false); // invalid direction value not matched as valid
  });

  it("representative sample: group with type and label", () => {
    const groupBeginRe = new RegExp(grammar.repository.groupStatement.begin);
    const samples = [
      "group Backend {",
      'group Frontend [subsystem] "Frontend" {',
      "group Auth {",
    ];
    for (const s of samples) {
      expect(groupBeginRe.test(s), `group begin should match: ${s}`).toBe(true);
    }
  });

  it("representative sample: edge with label", () => {
    const edgeBeginRe = new RegExp(grammar.repository.edgeStatement.begin);
    const samples = [
      "User -> Login",
      "Login -> Dashboard : success",
      "A -- B : associated",
      "API -> Database : query",
      "A->B",
      "A--B",
    ];
    for (const s of samples) {
      expect(edgeBeginRe.test(s), `edge begin should match: ${s}`).toBe(true);
    }
  });

  it("representative sample: node with type and label", () => {
    const nodeRe = new RegExp(grammar.repository.nodeStatement.match);
    expect(nodeRe.test('User [person]')).toBe(true);
    expect(nodeRe.test('API [service] "API Gateway"')).toBe(true);
    expect(nodeRe.test('Database [database]')).toBe(true);
    expect(nodeRe.test('Cache "In-Memory Cache"')).toBe(true);
    expect(nodeRe.test('User')).toBe(true);
  });

  it("representative sample: meta / note / link", () => {
    const metaRe = new RegExp(grammar.repository.metaStatement.match);
    expect(metaRe.test('meta author = "Alice"')).toBe(true);
    const noteRe = new RegExp(grammar.repository.noteStatement.begin);
    expect(noteRe.test('note "Global diagram note"')).toBe(true);
    expect(noteRe.test('note API "Handles auth"')).toBe(true);
    const linkRe = new RegExp(grammar.repository.linkStatement.match);
    expect(linkRe.test('link API "https://api.example.com"')).toBe(true);
  });
});

describe("assets / branding", () => {
  it("includes approved Floe SVGs and PNG icon", () => {
    expect(fs.existsSync(path.join(ROOT, "assets/floe.svg"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "assets/floe-light.svg"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "assets/floe-icon.png"))).toBe(true);
    const svg = fs.readFileSync(path.join(ROOT, "assets/floe.svg"), "utf-8");
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/<circle/);
    // PNG header
    const png = fs.readFileSync(path.join(ROOT, "assets/floe-icon.png"));
    // PNG magic bytes 89 50 4E 47 0D 0A 1A 0A
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
    // 128x128
    // IHDR width/height at bytes 16-23
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(128);
    expect(height).toBe(128);
  });

  it("LICENSE exists and is MIT", () => {
    const lic = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf-8");
    expect(lic).toMatch(/MIT License/);
  });
});

describe("src/extension.ts activation & malformed handling", () => {
  it("extension.ts exists and exports activate/deactivate", () => {
    const extPath = path.join(ROOT, "src/extension.ts");
    expect(fs.existsSync(extPath)).toBe(true);
    const src = fs.readFileSync(extPath, "utf-8");
    expect(src).toMatch(/export\s+(async\s+)?function\s+activate/);
    expect(src).toMatch(/export\s+(async\s+)?function\s+deactivate/);
    // must import vscode
    expect(src).toMatch(/from\s+["']vscode["']/);
    // must not contain a second semantic parser (no Lexer/Parser reimplementation)
    expect(src).not.toMatch(/class Lexer/);
    expect(src).not.toMatch(/class Parser/);
    expect(src).not.toMatch(/new Parser/);
    // should reference .floe (activation is onLanguage)
    expect(src).toMatch(/floe/);
  });

  it("malformed .floe does not cause activation failure (static check)", () => {
    // We validate that extension.ts does not throw on import and does not use eval
    const src = fs.readFileSync(path.join(ROOT, "src/extension.ts"), "utf-8");
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new Function/);

    // Grammar must be robust to malformed characters: ensure it handles UNKNOWN tokens gracefully
    const grammar = readJson("syntaxes/floe.tmLanguage.json");
    const malformedSamples = [
      "123User -> Login", // E002
      "User ->", // E009
      "direction XX", // E001
      "User []", // E008
      "A -> B :", // E010
      "group 123bad {", // invalid group id
      "User : label", // malformed
      "$invalid", // E007
      'User ["unterminated]', // stray
      "group X { unclosed", // E012
      "} stray brace", // E005
    ];
    // The grammar should be valid JSON regardless; and edge/node regexes should not throw when testing malformed inputs
    const edgeRe = new RegExp(grammar.repository.edgeStatement.begin);
    const nodeRe = new RegExp(grammar.repository.nodeStatement.match);
    const dirRe = new RegExp(grammar.repository.directionStatement.match);
    expect(() => {
      for (const s of malformedSamples) {
        // Just ensure regex execution does not throw
        edgeRe.test(s);
        nodeRe.test(s);
        dirRe.test(s);
        // comment and string regexes
        new RegExp(grammar.repository.comments.match).test(s);
        new RegExp(grammar.repository.strings.begin).test(s);
      }
    }).not.toThrow();
  });

  it("activation logic does not use eval or new Function and handles multiple documents", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/extension.ts"), "utf-8");
    // Check for correct vscode API usage for multi-doc handling
    expect(src).toMatch(/onDidOpenTextDocument/);
    expect(src).toMatch(/createOutputChannel/);
    // Deactivate should exist and be safe to call
    expect(src).toMatch(/deactivate/);
  });
});

describe("build artifacts", () => {
  it("tsconfig builds to dist/extension.js with correct module system", () => {
    const tsconfig = readJson("tsconfig.json");
    expect(tsConfigHasCorrectModule(tsconfig)).toBe(true);
    function tsConfigHasCorrectModule(cfg: any): boolean {
      const mod = cfg.compilerOptions?.module?.toLowerCase();
      return mod === "nodenext" || mod === "node16" || mod === "commonjs";
    }
  });

  it("README and CHANGELOG exist", () => {
    expect(fs.existsSync(path.join(ROOT, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "CHANGELOG.md"))).toBe(true);
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
    expect(readme).toMatch(/Floe/);
    expect(readme).toMatch(/\.floe/);
    expect(readme).toMatch(/direction LR/);
  });
});
