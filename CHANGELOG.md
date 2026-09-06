# Changelog

All notable changes to the Floe VS Code extension follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-05

### Added

#### Stage 4 — Editor Experience and UX Polish
- **Source/preview synchronization**:
  - File rename handling (preview updates when .floe files are renamed)
  - External file change detection via FileSystemWatcher
  - Multiple .floe document support with per-document preview tracking
  - Preview state preservation across editor switches
- **LSP-powered features**:
  - Document formatting provider (uses existing Floe formatter via LSP)
  - Document symbol provider for outline/navigation
  - Format on save support (via VS Code's `editor.formatOnSave`)
- **Keyboard shortcuts**:
  - `Ctrl+Shift+V` / `Cmd+Shift+V` — Open preview
  - `Ctrl+Shift+R` / `Cmd+Shift+R` — Refresh preview
- **Configuration**:
  - `floe.preview.autoUpdate` — Auto-update preview on file changes
  - `floe.trace.server` — LSP trace level
- **Performance measurement**:
  - Extension activation time logged
  - LSP startup time logged
  - Preview render times tracked
  - Document symbol retrieval times logged
- **Accessibility**:
  - Command palette accessible commands with proper categories
  - Context menu integration for preview
  - Editor title bar button for preview

#### Stage 3 — Preview
- Webview-based SVG diagram preview
- Debounced updates (150ms for typing, 300ms for validation, 500ms for external changes)
- Error state display with last valid diagram preserved
- CSP-compliant HTML generation

#### Stage 2 — LSP Integration
- Language Server Protocol client via vscode-languageclient
- Diagnostics, completion, hover, definition, references, rename
- Document folding ranges
- Server version checking and mismatch warnings
- Error handler with restart limits
- Multi-root workspace support
- Custom LSP path configuration

#### Stage 1 — Foundation
- Registers `.floe` with language ID `floe`
- TextMate syntax highlighting for all Floe v1.0 constructs
- Language configuration (comments, brackets, auto-closing, indentation)
- Approved Floe icon and branding
- Minimal activation — never crashes on malformed input

### Changed
- Improved output channel logging with timing information
- Better error messages with actionable guidance
- Preview title updates on rename

### Documentation
- Comprehensive README with Floe language reference
- Troubleshooting section
- Keyboard shortcuts guide
- Architecture overview
- Configuration options documented

### Notes
- Does not modify Floe core language; consumes frozen spec from `@fazelstudio/floe`
- Does not duplicate parser, formatter, or layout engine
- Relies on existing LSP server and renderer from @fazelstudio/floe
