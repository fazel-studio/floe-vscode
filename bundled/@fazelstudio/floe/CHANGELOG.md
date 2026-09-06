# Changelog

All notable changes to Floe follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-05

Initial stable open source release.

### Added
- Stable language `v1.0` — frozen grammar documented in `docs/00-language-freeze.md` and `SPEC.md`; `direction`, `node [type] "label"`, `edge -> / -- : label`, `group { }` (nested), `meta`, `note`, `link`
- Renderer-independent IR — `FloeDiagram`, `FloeNode`, `FloeEdge` (`kind: directed | undirected`), `FloeGroup`, `FloeAnnotation`, `FloeLink`, `Range` with stable diagnostics `E001`–`E014`
- Deterministic layout `SimpleLayoutEngine` (zero-deps) and SVG renderer `renderSvg` / `renderFloe` with `escapeXml` / `escapeId` and URL sanitization `src/security/url.ts`
- Editor-independent language services — `diagnostics`, `completion`, `hover`, `symbols`, `definition`, `references`, `rename`, `formatting`, `highlighting`, `indentation`, `folding`
- CLI `floe check | format | render | lsp` (exit codes 0/1/2, `--json`, `--write`, `-o`) and LSP server (`src/lsp/server.ts`) reusing language services
- Comprehensive corpus `corpus/basic`, `labels`, `nodes`, `groups`, `direction`, `metadata`, `invalid`, `edge-cases`, `large` plus examples `examples/*.floe`
- Tests — `bun run test` 387 tests (parser, validator, language, layout, render, CLI, LSP, security, fuzz, corpus)
- Benchmarks `benchmarks/run.ts` → `benchmarks/results.json` and bundle sizes `scripts/measure-bundle.ts` → `benchmarks/bundle-size.json`
- Documentation `docs/` — Introduction, Syntax, Language Specification, Semantic Model, Rendering, Layout, Validation, Formatting, AI Generation, Editor Integration, CLI, LSP, API, Examples, Security, Versioning, Package Strategy

### Security
- Untrusted `.floe` input never executed; SVG output sanitized, `javascript:`/`data:` URLs flagged as `E014`.
