<div align="center">
  <h1>@cyanheads/docgen-mcp-server</h1>
  <p><b>Render HTML/markdown to PDF, export rows to xlsx, and fill AcroForm PDFs via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/docgen-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/docgen-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/docgen-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/docgen-mcp-server/releases/latest/download/docgen-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=docgen-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZG9jZ2VuLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22docgen-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fdocgen-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Document rendering built on a bundled stack — pdf-lib for PDF and AcroForm fill, exceljs for spreadsheets, marked for markdown. Render HTML, markdown, or template data to PDF, export tabular rows to xlsx, and fill AcroForm PDF forms from any MCP client. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `docgen_render_pdf` | Render HTML, markdown, or a `{{key}}` template + data object to a downloadable PDF |
| `docgen_export_spreadsheet` | Render one or more named worksheets of row objects to a downloadable `.xlsx` workbook |
| `docgen_fill_form` | Fill the AcroForm fields of a supplied PDF (base64 or https URL) and optionally flatten it |
| `docgen_get_document` | Re-fetch a previously rendered document by the id a render/export/fill tool returned |

### Resources

| Resource | Description |
|:---|:---|
| `docgen://document/{documentId}` | A rendered document by id — raw bytes as a blob plus a JSON metadata block |

All document data is also reachable via the tool surface — `docgen_get_document` is the tool-only twin of this resource.

## Capability reference

### `docgen_render_pdf` <sub>tool</sub>

- Provide exactly one `source`: `{ html }`, `{ markdown }`, or `{ template, data }` for `{{key}}` interpolation. `pageOptions` controls page size/orientation, CSS-length margins, headers/footers (`{{page}}`, `{{total}}`, `{{date}}`) and page numbers.
- Returns a `DocumentEnvelope` with `pageCount`; `degraded: true` signals dropped CSS, images or scripts. The lightweight engine renders headings, paragraphs, lists and tables.
- Typed failures: `invalid_source`, `template_render_failed`, `document_too_large`, `render_timeout`.

---

### `docgen_export_spreadsheet` <sub>tool</sub>

- Supply at least one sheet with a unique `name` (1–31 characters) and scalar `rows[]`; empty rows yield a header-only sheet. Optional `columns[]` sets headers, type (`string` / `number` / `date` / `boolean`), width and Excel format.
- Returns a `DocumentEnvelope` with `sheetCount`. Typed failures: `empty_workbook`, `invalid_sheet_name`, `document_too_large`, `render_timeout`.

---

### `docgen_fill_form` <sub>tool</sub>

- Provide exactly one `sourcePdf`: `{ base64 }` or `{ url }` (public https serving `application/pdf`), plus `fields` mapping exact, case-sensitive AcroForm field names to values. Flat or XFA-only PDFs return `not_a_form`.
- Returns a `DocumentEnvelope` with `pageCount` and `unmatchedFields[]` for names with no matching field.
- `flatten: true` makes the filled values non-editable (default `false`).

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

- No external API — a bundled rendering stack (`pdf-lib`, `exceljs`, `marked`), so renders are local and deterministic with no upstream to fail
- One shared `DocumentEnvelope` across all four tools — the three writers and the reader are interchangeable to the agent, and the resource-URI vs. inline-base64 delivery decision lives in one place
- Bounded renders — a per-document byte ceiling (`DOCGEN_MAX_DOCUMENT_BYTES`) and a wall-clock timeout (`DOCGEN_RENDER_TIMEOUT_MS`) turn a runaway render into a typed, recoverable error instead of a hang
- Tenant-scoped, TTL-bounded storage — a document id minted for one tenant resolves only for that tenant; outputs are downloads, not records, so they expire rather than accumulate
- SSRF-guarded form fetch — `docgen_fill_form` with a URL source resolves DNS and checks the destination IP before fetching, blocking private/loopback/link-local ranges

Agent-friendly output:

- Dual-surface delivery — every envelope field lands in both `structuredContent` and the `format()` markdown twin, so tool-only and resource-only clients both see the `documentId`, resource URI, inline-availability status, size, and TTL
- Inline-vs-resource by size — `inlineBase64` is populated only at or under `DOCGEN_INLINE_MAX_BYTES`, so a large workbook isn't base64-inlined into a tool result; above the threshold, delivery is via the resource URI
- Partial-fill reporting — `docgen_fill_form` returns `unmatchedFields[]` so the agent learns which field names didn't land and can correct and re-render rather than assuming a clean fill
- Typed error contract with recovery hints — each tool declares its failure surface (`invalid_source`, `template_render_failed`, `document_too_large`, `render_timeout`, `not_a_form`, `source_unfetchable`, `document_expired`, …) with actionable next-step text

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+); development uses Bun v1.4.2.

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
| `MCP_SESSION_MODE` | HTTP session posture: `auto`, `stateful`, or `stateless`. docgen declares `stateless` in code, since no tool asks for input mid-handler and documents live in tenant-scoped storage rather than the session store. The env var overrides it when set; the framework's `auto` default resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_PUBLIC_URL` | Public origin behind a TLS proxy. (The `downloadUrl` envelope field is reserved for a future HTTP download route and is not emitted in this version.) | — |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed arguments/results, redacted by key name and capped by `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). Free-form values may retain secrets. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend for document bytes + metadata. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL; traces use `/v1/traces`, metrics use `/v1/metrics`. Signal-specific endpoints override it. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in log endpoint, used as-is; the base URL never enables log export. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

> Documents are stored in `ctx.state`, which the in-memory provider keeps in process memory — a restart drops every stored document, and an id minted before the restart returns `document_expired`. This is intended (outputs are downloads, not records); for durable retention across restarts, point `STORAGE_PROVIDER_TYPE` at a persistent backend.

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
