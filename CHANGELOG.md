# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-27 · ⚠️ Breaking · 🛡️ Security

Breaking: the downloadUrl envelope field is no longer emitted — no HTTP route served it. Documents deliver via the docgen://document/{id} resource URI and inline base64. Security: document ids are validated at the schema boundary so malformed ids no longer leak storage internals. The template_render_failed recovery hint now reaches the wire.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

First published release — render structured agent content into downloadable documents: HTML/markdown/template to PDF, tabular rows to xlsx, and AcroForm PDF fill, delivered through a shared tenant-scoped, TTL-bounded DocumentEnvelope (resource URI and inline base64). Published under the @cyanheads npm scope.
