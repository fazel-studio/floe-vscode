# Floe for Visual Studio Code

Provides first-class support for the **Floe** diagram language — a lightweight, human-readable, AI-friendly DSL for directed graphs.

## Features

This extension brings the complete Floe toolchain directly into VS Code:

- **Live Preview**: Split the editor to see your diagrams rendered in real-time as you type. Includes dark mode support and interactive pan/zoom.
- **Syntax Highlighting**: Beautiful and accurate TextMate grammars for `.floe` files.
- **Language Server Features**:
  - **Diagnostics**: Real-time syntax and semantic validation.
  - **Auto-completion**: Smart suggestions for nodes, node types, and keywords.
  - **Hover Information**: Peek into node details and metadata.
  - **Formatting**: Auto-format your diagrams (supports `Format Document`).
  - **Document Symbols**: Navigate complex diagrams easily via the Outline view or breadcrumbs.

## Usage

1. Open any `.floe` file.
2. Click the **Open Preview to the Side** icon `[]|[]` in the top right of the editor, or use `Ctrl+Shift+V` (`Cmd+Shift+V` on Mac).
3. Type your diagram code and watch it update live.

## Extension Settings

You can customize the extension via `settings.json`:

* `floe.preview.autoUpdate`: Automatically update the preview when the source file changes (default: `true`).
* `floe.languageServer.enabled`: Enable or disable the Floe Language Server features (default: `true`).
* `floe.languageServer.path`: Custom path to a specific Floe language server executable (optional).

## Requirements

No external dependencies are required! The extension comes bundled with the `@fazelstudio/floe` compiler engine.

*(Note: If you have `@fazelstudio/floe` installed locally in your workspace's `node_modules`, the extension will intelligently use your workspace version instead of the bundled one.)*

## Known Issues

- Advanced text wrapping and metadata annotations (`meta`, `note`, `link`) are parsed correctly but are not yet visually rendered in the SVG output by the underlying Floe compiler engine (v1.x).

## Release Notes

### 0.1.0
- Initial release of Floe VS Code extension.
- Syntax highlighting and LSP integration.
- Live SVG Preview with dark mode support.
