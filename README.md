<div align="center">
  <h1>@cyanheads/docgen-mcp-server</h1>
  <p><b>Render HTML/markdown to PDF, export rows to xlsx, and fill AcroForm PDFs via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Document Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/docgen-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/docgen-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/docgen-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/docgen-mcp-server/releases/latest/download/docgen-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=docgen-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZG9jZ2VuLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22docgen-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fdocgen-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Generate documents from an agent: render HTML, markdown, or template data to PDF, export rows to Excel, and fill PDF forms. Everything renders locally on a bundled stack (pdf-lib, exceljs, marked).

### Tools

| Tool | Description |
|:---|:---|
| `docgen_render_pdf` | Render HTML, markdown, or a `{{key}}` template + data object to a downloadable PDF |
| `docgen_export_spreadsheet` | Render one or more named worksheets of row objects to a downloadable `.xlsx` workbook |
| `docgen_fill_form` | Fill the AcroForm fields of a supplied PDF (base64 or https URL) and optionally flatten it |
| `docgen_list_form_fields` | Inspect AcroForm names, values, constraints, choice options and widget pages without changing the PDF |
| `docgen_get_document` | Re-fetch a previously rendered document by the id a render/export/fill tool returned |

### Resources

| Resource | Description |
|:---|:---|
| `docgen://document/{documentId}` | A rendered document by id — raw bytes as a blob plus a JSON metadata block |

`docgen_get_document` retrieves the delivery envelope. Read the resource for bytes when the envelope omits inline base64.

### Skill

[`docgen-guide`](./skills/docgen-guide/SKILL.md) walks through inspecting, filling, verifying, and flattening an AcroForm PDF. It is available to plugin hosts and MCP clients that support the Skills extension.

## Capability reference

### `docgen_render_pdf` <sub>tool</sub>

- Provide exactly one `source`: `{ html }`, `{ markdown }`, or `{ template, data }` for `{{key}}` interpolation. `pageOptions` controls page size/orientation, CSS-length margins, headers/footers (`{{page}}`, `{{total}}`, `{{date}}`) and page numbers.
- Returns a `DocumentEnvelope` with `pageCount`; `degraded: true` means CSS, images or scripts were dropped, or characters were replaced with `?`. The lightweight engine renders headings, paragraphs, lists and tables.
- Typed failures: `invalid_source`, `template_render_failed`, `document_too_large`, `render_timeout`.

---

### `docgen_export_spreadsheet` <sub>tool</sub>

- Supply at least one sheet with a unique `name` (1–31 characters) and scalar `rows[]`; empty rows yield a header-only sheet. Optional `columns[]` sets headers, type (`string` / `number` / `date` / `boolean`), width and Excel format.
- Omitted columns use all row keys in first-seen order. Boolean columns accept `true/1/yes/on` and `false/0/no/off`, case-insensitive; other strings stay text.
- Returns a `DocumentEnvelope` with `sheetCount`. Typed failures: `empty_workbook`, `invalid_sheet_name`, `document_too_large`, `render_timeout`.

---

### `docgen_fill_form` <sub>tool</sub>

- Provide exactly one `sourcePdf`: `{ base64 }` or `{ url }` (public HTTPS serving `application/pdf`, or `application/octet-stream` whose bytes start with `%PDF-`), plus a `fields` map. Flat or XFA-only PDFs return `not_a_form`.
- Inspect unfamiliar PDFs with `docgen_list_form_fields`. Exact names take precedence across the whole map; a unique last segment or case-insensitive full name also works. Ambiguous or conflicting aliases remain unmatched.
- Returns a `DocumentEnvelope` with `pageCount`, `unmatchedFields[]`, `resolvedFields[]` for accepted aliases, and `madeEditableFields[]` for dropdowns made editable by custom text. The accompanying notices disclose custom dropdown values and unrecognized checkbox values.
- Checkboxes accept booleans, common checked/unchecked strings and their PDF export value. Radios and option lists accept an exact option or a unique case-insensitive match. Dropdown custom text is preserved verbatim.
- Invalid assignments are reported together as `invalid_field_value`, with field constraints and a recovery hint; no document is stored on failure.
- `flatten: true` makes the filled values non-editable (default `false`).

---

### `docgen_list_form_fields` <sub>tool</sub>

- Accepts the same `sourcePdf` base64-or-URL source as `docgen_fill_form`. Returns `{ fields: [{ name, type, required, options?, label?, maxLength?, onValue?, value?, page? }] }` without modifying the PDF or storing a document.
- Types: `text`, `checkbox`, `dropdown`, `optionList`, `radioGroup`, `signature`, `button`. Only dropdown, optionList and radioGroup entries include `options`; signatures and buttons are discovery only.
- Optional metadata reflects the PDF: tooltip, text length limit, checkbox export value, current value and the first widget's 1-based page. Missing metadata is omitted; unchecked boxes and empty selections remain `false` and `[]`. Nested names retain their exact paths. PDFs without AcroForm fields return `not_a_form`.

---

### `docgen_get_document` <sub>tool</sub>

- Supply the `documentId` an earlier render/export/fill returned (`doc_` plus 24 url-safe characters).
- Re-fetches its `DocumentEnvelope` without rendering again; an expired or unknown id returns `document_expired`.

---

### `docgen://document/{documentId}` <sub>resource</sub>

- Use the `documentId` from a render/export/fill result (`doc_` plus 24 url-safe characters).
- Returns a base64 `blob` with the document's MIME type and JSON metadata (`documentId`, `byteSize`, `pageCount`/`sheetCount`, `createdAt`, `ttlSecondsRemaining`). Reads the same store as `docgen_get_document`; expired or unknown ids return `document_expired`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

docgen-specific:

- Bundled rendering stack (`pdf-lib`, `exceljs`, `marked`); only caller-supplied URL sources require a network fetch
- One shared `DocumentEnvelope` across the four document delivery tools; field inspection returns its inventory directly
- Bounded renders — a byte ceiling (`DOCGEN_MAX_DOCUMENT_BYTES`) and a timeout (`DOCGEN_RENDER_TIMEOUT_MS`) turn a runaway render into a typed error instead of a hang
- Tenant-scoped, expiring storage — a document id resolves only for the tenant that created it, and documents expire rather than accumulate
- SSRF-guarded form fetch — both form tools check every address, including each redirect hop, and block private, loopback and link-local destinations

Agent-friendly output:

- Dual-surface delivery — every envelope field appears in both `structuredContent` and the markdown output, including the `documentId`, resource URI, size, and TTL
- Inline by size — `inlineBase64` is populated only at or under `DOCGEN_INLINE_MAX_BYTES`; larger documents are delivered through the resource URI
- Fill reporting — unmatched names, resolved aliases and dropdown editability changes are visible on both output surfaces
- Typed errors with recovery hints (`invalid_source`, `template_render_failed`, `document_too_large`, `render_timeout`, `not_a_form`, `source_unfetchable`, `document_expired`, …); semantic validation uses `ValidationError` (`-32007`) and malformed arguments `InvalidParams` (`-32602`)

## Getting started

Add the following to your MCP client configuration file. No API keys are required.

```json
{
  "mcpServers": {
    "docgen-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/docgen-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "docgen-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/docgen-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "docgen-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/docgen-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

Documents are delivered by the `docgen://document/{id}` resource (and inline base64 when small enough) over every transport. The envelope's `downloadUrl` field is reserved for a future HTTP download route and is not emitted in this version.

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+). Development uses Bun v1.4.4.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/docgen-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd docgen-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to override any defaults
```

## Configuration

All configuration is optional — docgen runs with no required environment variables.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `DOCGEN_DOCUMENT_TTL_SECONDS` | How long a rendered document is retrievable before it expires, in seconds. | `900` |
| `DOCGEN_MAX_DOCUMENT_BYTES` | Hard ceiling on a single rendered artifact in bytes; exceeding it aborts the render. | `26214400` |
| `DOCGEN_RENDER_TIMEOUT_MS` | Per-render wall-clock budget in milliseconds; exceeding it aborts the render. | `30000` |
| `DOCGEN_INLINE_MAX_BYTES` | Artifacts at or under this byte size are returned inline as base64; larger ones omit it. | `5242880` |
| `DOCGEN_PDF_ENGINE` | PDF rendering engine. Only `lightweight` is implemented; `chromium` is reserved and rejected at startup. | `lightweight` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_PUBLIC_URL` | Public origin behind a TLS proxy. | — |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed arguments/results, redacted by key name and capped by `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). Free-form values may retain secrets. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend for document bytes + metadata. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL; traces use `/v1/traces`, metrics use `/v1/metrics`. Signal-specific endpoints override it. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in log endpoint, used as-is; the base URL never enables log export. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

> The default in-memory storage drops every document on restart, and earlier ids then return `document_expired`. To keep documents across restarts, point `STORAGE_PROVIDER_TYPE` at a persistent backend.

When upgrading a filesystem store from mcp-ts-core 0.13.21 or earlier, the first start copies existing data into `_v2/` under `STORAGE_FILESYSTEM_PATH`. Allow room for both copies and upgrade every instance sharing the path before resuming writes.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t docgen-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 docgen-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/docgen-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers the tools/resource and inits the render + storage services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/document` | The rendering stack (`RenderService`) and artifact store (`DocumentStore`), shared types, and the SSRF fetch guard. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in `src/index.ts`'s `createApp()` arrays
- One shared `DocumentEnvelope` across all delivery tools — keep the writers and reader interchangeable

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
