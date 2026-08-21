# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-08-21

MCP SDK v2 and mcp-ts-core 0.12.3 adoption, with Bun 1.4/TypeScript 7 tooling, expanded contract coverage, and portable MCPB/Docker packaging.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-28

Input-validation fixes across the writer tools: worksheet names are checked against Excel's constraints before render, fill_form accepts line-wrapped base64 PDFs, and render_pdf rejects data supplied without a template. Plus a design-doc correction of stale downloadUrl references.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking · 🛡️ Security

Breaking: the downloadUrl envelope field is no longer emitted — no HTTP route served it. Documents deliver via the docgen://document/{id} resource URI and inline base64. Security: document ids are validated at the schema boundary so malformed ids no longer leak storage internals. The template_render_failed recovery hint now reaches the wire.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

First published release — render structured agent content into downloadable documents: HTML/markdown/template to PDF, tabular rows to xlsx, and AcroForm PDF fill, delivered through a shared tenant-scoped, TTL-bounded DocumentEnvelope (resource URI and inline base64). Published under the @cyanheads npm scope.
