<p align="center">
  <img src="assets/floe.svg" width="128" height="128" alt="Floe" />
</p>

# Floe — Diagram DSL

Lightweight, human-readable, AI-friendly diagram language. Files are `.floe`.

> **v1.0 Stable** — language frozen, see `docs/00-language-freeze.md` and `SPEC.md` for source of truth. All v1.0 checklist items are complete.

## Scope v1.0 — Stable

Implemented (v0.1–v1.0):

- `.floe` source format and frozen language specification (`SPEC.md`, `docs/00-language-freeze.md`)
- Lexer + grammar-based parser with source ranges and error recovery (never crashes) — fuzz tested
- Renderer-independent semantic model / IR (nodes, edges, groups, metadata, annotations, links) — reviewed
- Diagnostics with stable codes (`E001`–`E014`) + `E014` for unsafe URLs
- Deterministic layout (`SimpleLayoutEngine` — zero-dep) and SVG renderer (`renderSvg`, `renderFloe`) — escaped, sanitized
- Language services (editor-independent): diagnostics, completion, hover, go-to-definition, references, rename, formatting, symbols, highlighting, folding, indentation, folding ranges
- CLI: `floe check`, `floe format`, `floe render` (scriptable, correct exit codes 0/1/2)
- LSP: editor-independent Language Server (diagnostics, completion, hover, definition, references, rename, formatting, symbols, folding) reusing core services
- Comprehensive corpus: `basic/`, `labels/`, `nodes/`, `groups/`, `direction/`, `metadata/`, `invalid/`, `edge-cases/`, `large/` + legacy
- Performance benchmarks (`benchmarks/run.ts`) + bundle sizes (`scripts/measure-bundle.ts`) — actual measurements only
- Security review (`docs/security.md`) — SVG escaping, URL sanitization, no `eval`
- Documentation suite (`docs/`) — Introduction, Syntax, Semantic Model, Rendering, Layout, Validation, Formatting, AI Generation, Editor, CLI, LSP, API, Examples + AI reference
- Package strategy (`docs/package-strategy.md`) — only `@fazelstudio/floe` + `@fazelstudio/codemirror-lang-floe` for v1.0
- Versioning policy (`docs/versioning.md`) — SemVer after 1.0, breaking changes require major + migration

Not in v1.0: VS Code extension (architecture ready, separate repo).

## Install & Build (Bun — recommended, faster)

```bash
bun install
bun run build
bun run test
bun run typecheck
# npm still works: npm install / npm run build / npm test
```

## CLI (v1.0)

```bash
# Validate
floe check diagram.floe          # exit 0 OK, 1 errors, 2 usage
floe check diagram.floe --json   # JSON for CI

# Format (canonical)
floe format diagram.floe                 # print to stdout
floe format diagram.floe --write         # overwrite in place
floe format diagram.floe --check         # CI: exit 1 if not formatted

# Render to SVG (deterministic, safe)
floe render diagram.floe                 # SVG to stdout
floe render diagram.floe -o out.svg      # write file

# LSP (stdio) for editors
floe lsp --stdio
# Architecture: Editor → LSP → Floe Language Services → Parser/Semantic Model
# Works with VS Code, Neovim, Zed, Helix, any LSP client (no editor-specific semantics)
```

## LSP (v1.0)

Editor-independent Language Server reusing `src/language/*`:

- diagnostics (publishDiagnostics)
- completion
- hover
- go-to-definition
- references
- rename
- formatting
- symbols (documentSymbol)

Run: `bun ./dist/src/cli/main.js lsp` or `floe lsp` (also `node ./dist/src/cli/main.js`)

```bash
bun run build
bun ./dist/src/lsp/server.js   # or via CLI / node
```

## Usage

```ts
import { parseFloe } from "@fazelstudio/floe";
import { renderFloe } from "@fazelstudio/floe/pipeline";

const { diagram, diagnostics } = parseFloe(`
direction LR
// auth flow
User -> Login
Login -> Dashboard : success
Login -> Error : invalid
User [person]
`);

if (diagnostics.some(d => d.severity === "error")) {
  console.log(diagnostics);
} else {
  console.log(diagram.direction); // "LR"
  console.log(diagram.nodes);     // [{ id: "User", type: "person", ... }, ...]
  console.log(diagram.edges);     // [{ source: "Login", target: "Dashboard", label: "success", ... }]
  const { svg } = renderFloe(`
    direction LR
    User -> Login
    Login -> Dashboard : success
  `);
  console.log(svg); // deterministic SVG
}

// Raw parse without validation (if needed)
import { parseRaw } from "@fazelstudio/floe";
const raw = parseRaw(source);
```

## Identifier Rules

See `SPEC.md §4`. TL;DR: `^[A-Za-z_][A-Za-z0-9_-]*$`, no spaces, no Unicode, no leading digit.

## Diagnostics Codes

`E001` invalid direction, `E002` invalid identifier, `E003` duplicate node, `E004` duplicate direction, `E005` malformed/unexpected, `E006` incomplete, `E007` invalid character, `E008` invalid node type, `E009` missing edge target, `E010` empty label.

All diagnostics carry `range { start: { line, column, offset }, end: ... }`.

## Project Structure

```
src/
  range.ts        # Position/Range
  diagnostics.ts  # Diagnostic + codes (E001–E014)
  types.ts        # IR (FloeDiagram, FloeNode, FloeEdge, etc.)
  lexer.ts        # lexical grammar
  parser.ts       # recursive-descent parser with recovery
  validator.ts    # semantic validation (separate phase)
  index.ts        # public stable API (parseFloe, parseRaw, isValid)
  language/       # editor-independent services (completion, hover, etc.)
  layout/         # deterministic layout engines (Simple + Dagre)
  render/         # SVG renderer (escaped, safe)
  cli/            # CLI: check, format, render
  lsp/            # LSP server (reuses language services)
  security/       # URL sanitization
SPEC.md           # language spec (source of truth)
docs/             # v1.0 docs: Introduction, Syntax, Semantic Model, Rendering, Layout, Validation, Formatting, AI Gen, Editor, CLI, LSP, API, Examples, Freeze, Versioning, Security, Package
corpus/
  basic/ labels/ nodes/ groups/ direction/ metadata/ invalid/ edge-cases/ large/  # comprehensive (v1.0)
  valid/ invalid/  # legacy flat (kept for compat)
examples/         # runnable .floe examples
benchmarks/       # performance & bundle-size results
tests/            # parser, validator, language, render, lsp, cli, security, fuzz, corpus-comprehensive
```

## Runtime Compatibility

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js | ✅ Tested | v18+; `npm test` 194 passed, `node ./dist/src/cli/main.js check/format/render/lsp` OK |
| Browser | ✅ Core only | `src/index.ts:1` pure TS, no `fs`/`eval`; no bundler test but no Node imports |
| Bun | ✅ Tested | v1.3.11; `bun -e` core ok, `bun ./dist/src/cli/main.js check/format/render` OK |
| Deno | ✅ Tested | v2.9.6; `deno run --allow-read src/index.ts` core PASS, `deno run --allow-read --allow-write --allow-env dist/src/cli/main.js check/format/render/lsp` OK (2026-09-05 Win32) |

All except browser bundle are tested and claimed. Core is universal pure JS.

## Tests

```bash
bun run test   # or npm test
# 387 tests, includes fuzz (1000+ random), corpus-comprehensive (basic/labels/nodes/groups/direction/metadata/invalid/edge-cases/large), security, CLI, LSP, codemirror
bun run benchmark      # actual performance numbers → benchmarks/results.json
bun run bundle:measure # actual bundle sizes per package → benchmarks/bundle-size.json
```

Covers: basic edges, multiple edges, edge labels, explicit node types, comments, directions, whitespace, empty files, duplicate declarations, invalid syntax, incomplete syntax, invalid identifiers, source ranges, never-crash, fuzz (no crash/hang/memory), large diagrams (500–2000 nodes), security, CLI/LSP/CodeMirror.

## Architecture Rules

Core (`src/` without `cli/` and `lsp/`) has zero dependencies on CodeMirror, React, Vue, DOM, SVG, Canvas, Dagre, ELK, LSP. Pure language only. CLI and LSP are separate entry points that reuse core.

## Security

- `.floe` files are treated as **untrusted**. Never uses `eval`/`new Function` or equivalent.
- Generated SVG escapes `& < > " '` and sanitizes `id` attributes; no `<script>`, event handlers, or `javascript:` vectors from user content.
- See `tests/security.test.ts` for untrusted-input coverage.

## Editor Compatibility

Architecture is editor-agnostic:

```
Editor (VS Code / Neovim / Zed / Helix)
  ↓ LSP (stdio, JSON-RPC)
Floe Language Services (src/language/*)
  ↓
Parser / Semantic Model
```

No editor-specific semantic implementation exists; all intelligence is in `src/language/*` and reused by LSP.
