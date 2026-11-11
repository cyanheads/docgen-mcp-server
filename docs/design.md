# docgen-mcp-server — Design

Document generation as an MCP server: structured content (or template + data) in, a
downloadable binary document out. The server exists because an agent **cannot emit bytes** —
it can write a perfect invoice's HTML or a clean data table as tokens, but it cannot type a
`.pdf` or an `.xlsx`. docgen is the renderer that closes that gap.

Source of truth for scope and decisions: [`docs/idea.md`](./idea.md).

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `docgen_render_pdf` | Render HTML/markdown (or a template + data) to a PDF document. | `false` | `false` | `source` (oneOf discriminated-union: `{ html: string }` \| `{ markdown: string }` \| `{ template: string, data: Record<string,unknown> }`), `pageOptions` | `DocumentEnvelope` (id, resource URI, mime, byte size, page count, TTL, optional inline base64) |
| `docgen_export_spreadsheet` | Render one or more named sheets of row objects to an `.xlsx` workbook. | `false` | `false` | `sheets[]` (name + rows + optional column spec) | `DocumentEnvelope` (without `pageCount`; adds `sheetCount`) |
| `docgen_fill_form` | Fill the AcroForm fields of a supplied PDF, optionally flatten it. | `false` | `false` | `sourcePdf` (oneOf: `base64` \| `url`), `fields` (name→value map), `flatten` | `DocumentEnvelope` + `unmatchedFields[]`, `resolvedFields[]`, `madeEditableFields[]` and notices |
| `docgen_list_form_fields` | Inspect every supported AcroForm field without modifying or storing the PDF. | `true` | `false` | `sourcePdf` (exactly one of `base64` \| `url`) | `{ fields: [{ name, type, required, options?, label?, maxLength?, onValue?, value?, page? }] }` |
| `docgen_get_document` | Re-fetch a previously rendered document by the id a `render/export/fill` tool returned. | `true` | `false` | `documentId` | `DocumentEnvelope` (same shape the originating tool returned) |

`readOnlyHint` is `false` on the three `render/export/fill` tools because each **writes** a stored
artifact (tenant-scoped storage, TTL-bounded) as a side effect — even though no external
system is mutated. `docgen_get_document` and `docgen_list_form_fields` are pure reads. `openWorldHint` is `false`
everywhere: all rendering is local and deterministic, no live external API is contacted at
render time. (`docgen_fill_form` with `sourcePdf.url` fetches one caller-named URL — an
explicit input, not open-world discovery; see Design Decisions.)

### Resources

| URI or template | Returns |
|---|---|
| `docgen://document/{documentId}` | The rendered document — two content items: (1) a `blob` with `mimeType` set to the document's real mime type and the raw bytes as base64, and (2) a `text` item containing a JSON metadata block (`{ documentId, byteSize, pageCount?, sheetCount?, createdAt, ttlSecondsRemaining }`). `documentId` is the id returned by any `render/export/fill` tool. Readable until the TTL expires, then `notFound`. |
| `skill://docgen-guide/SKILL.md` | Published inspect → fill → review → flatten workflow. Listed in `resources/list` and available through the Skills extension; the SDK registers a `skill://{+path}` resource template. |

The resource is the stable-URI delivery surface: a host that supports resources resolves
`docgen://document/{id}` to fetch the bytes directly. `docgen_get_document` reads the same
store and returns the delivery envelope under the same inline size limit. When inline
bytes are omitted, the resource is required to retrieve them. Neither path re-renders.

### Prompts

None in v1. docgen is action-oriented — there is no recurring multi-step guided workflow
that a prompt template would structure. (A "build me an invoice" prompt is plausible later
but is template-authoring sugar, not a workflow; deferred.)

---

## Overview

docgen-mcp-server renders structured agent content into downloadable binary documents. It
wraps **no external API** — the "service" is a bundled rendering stack (`pdf-lib` for PDF
and form fill, `exceljs` for spreadsheets, a markdown→HTML step for the markdown path). The
server itself is the source of truth: it produces an ephemeral artifact, stores it
tenant-scoped with a TTL, and hands back a delivery envelope.

The core value is being the **only path to the output**. Mermaid, SVG, charts, and HTML are
already rendered client-side by Claude artifacts and rich clients, so a "diagram renderer"
is mostly mooted. The un-mootable core is a file a human downloads and keeps: a PDF, a
spreadsheet, a filled form. Demand is human-driven (the human wants the file) rather than
agent-reasoning-driven, so call volume is lower and burstier than a data server's — docgen
earns its place by being the export stage other servers don't have, not by being reached for
constantly.

The primary agent workflows:

1. **Agent-authored document → PDF.** The model writes styled HTML (its strength) or
   markdown; the server prints it to a PDF the human downloads.
2. **Tabular data → spreadsheet.** An agent (often holding rows from another server — a
   `secedgar` financial summary, a `usaspending` award report, a `census` table) exports a
   real `.xlsx` with headers, types, and multiple sheets.
3. **Fill a provided form.** The human has a PDF form (a tax form, an application); the agent
   maps field values and gets back a filled, optionally flattened PDF.
4. **Re-fetch / poll.** A caller re-fetches a document whose inline copy it dropped, or (for
   the deferred async high-fidelity path) polls until a heavy render completes.

The strongest demand signal is the cross-server pairing **"fetch data → render a document."**
docgen is the export stage that data-returning servers lack; its natural callers are the rest
of the fleet.

---

## Requirements

**Functional**

- Render HTML or markdown to PDF with control over page size, orientation, margins,
  header/footer, and page numbers.
- Render a template (HTML/Handlebars) + a structured data object to PDF (server owns layout).
- Render one or more named sheets of row objects to `.xlsx`, with an optional per-column spec
  (header label, type, width, number/date format).
- Fill the AcroForm fields of a supplied PDF (base64 or URL) from a field→value map, and
  optionally flatten.
- Discover exact nested AcroForm names, required flags and canonical types (`text | checkbox | dropdown | optionList | radioGroup | signature | button`). Optional attributes expose the tooltip, maximum text length, checkbox on-state, current value and first widget's page. Only dropdown, optionList and radioGroup expose `options`; signatures and buttons are discovery only. Inspection neither saves the PDF nor writes a stored document.
- Deliver every output two ways from one envelope: a **resource URI** (stable read path) and
  **inline base64** (local/stdio path), carrying identical metadata. (A hosted `downloadUrl` is
  reserved for a future HTTP download route — not emitted in v1.)
- Re-fetch a stored document by id until its TTL expires.

**Non-functional**

- **Local rendering.** Only URL-sourced PDFs require network access; their guarded fetch tries vetted destinations within one deadline. There is no external rendering API.
- **Bounded renders.** A per-document byte ceiling and a render timeout bound a runaway
  render (a pathological HTML page, an enormous sheet set). Exceeding either is a typed,
  recoverable error, not a hang.
- **Ephemeral storage.** Rendered artifacts live in tenant-scoped storage with a short TTL
  and survive nothing meaningful across a restart (in-memory provider) — outputs are
  download-and-go. A durable provider (filesystem / R2) is a config swap, not a code change.
- **Tenant isolation.** A document id minted for one tenant resolves only for that tenant —
  enforced by `ctx.state` tenant-prefixing; a leaked id does not cross the tenant boundary.
- **HTTP delivery remains deferred.** Both transports deliver document bytes through MCP resources or inline base64; no direct download route is served.

**Out of scope (v1)**

- **`.docx`** — faithful Word output is far harder than PDF/xlsx and lower-value for agents.
  Deferred until real demand appears.
- **Diagrams / charts / SVG** — already rendered client-side; deliberately not docgen's job.
- **Document text extraction/parsing** — form-field inventory is supported, but general document reading remains out of scope.
- **High-fidelity HTML→PDF via headless Chromium** — deferred behind a flag; v1 ships the
  lightweight programmatic path (see Design Decisions and v1 Scope).

---

## Data Model

### `DocumentEnvelope` — the shared delivery shape

Every `render/export/fill` tool and `docgen_get_document` returns the same envelope so all four read
identically. The bytes ride as a resource link and/or inline base64; the metadata is always
present on both client surfaces.

```ts
interface DocumentEnvelope {
  documentId: string;        // opaque id minted by the render/export/fill tool; the chaining key for
                             //   docgen_get_document and the docgen://document/{id} resource.
                             //   Format: `doc_` + 24 url-safe chars. Obtain it ONLY from a
                             //   render/export/fill tool's output — it is not guessable or constructible.
  resourceUri: string;       // `docgen://document/{documentId}` — the stable read URI.
  downloadUrl?: string;      // reserved for a future HTTP download route — not emitted in v1
                             //   (the field is always absent). Fetch via resourceUri / inlineBase64.
  mimeType: DocumentMime;    // 'application/pdf'
                             //   | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  byteSize: number;          // size of the rendered artifact in bytes — z.number().int().nonnegative()
  pageCount?: number;        // PDF only (render_pdf, fill_form) — z.number().int().positive()
  sheetCount?: number;       // xlsx only (export_spreadsheet) — z.number().int().positive()
  ttlSecondsRemaining: number; // seconds until the stored artifact expires — z.number().int().nonnegative()
  createdAt: string;         // ISO 8601 UTC (e.g. "2026-06-23T12:00:00.000Z")
  inlineBase64?: string;     // the bytes, base64. Present (z.string().optional()) when the
                             //   artifact is at or under DOCGEN_INLINE_MAX_BYTES; field is
                             //   absent (not empty string) when larger. Fetch via resourceUri
                             //   when omitted. See Output Design Notes.
}
```

`DocumentMime` is a Zod enum (two literals in v1), never a bare `string` — it constrains the
output and documents exactly which formats exist.

### Stored record (internal, tenant-scoped)

What persists between a `render/export/fill` call and a later `docgen_get_document` / resource read.
Split into a **lightweight metadata record** and the **base64 bytes** under two separate
`ctx.state` keys, so a read can fetch the small meta record without pulling the multi-MB blob
along with it:

```ts
// ctx.state key: `doc/meta/{documentId}`  (tenant-prefixed automatically)
interface StoredDocumentMeta {
  documentId: string;
  blobKey: string;           // `doc/blob/{documentId}` — the ctx.state key holding the base64 bytes
  mimeType: DocumentMime;
  byteSize: number;
  pageCount?: number;
  sheetCount?: number;
  createdAt: string;
  expiresAtMs: number;       // absolute expiry (epoch ms) — used to compute ttlSecondsRemaining on read
}
// bytes: base64 string under `doc/blob/{documentId}`, written with the same TTL as the meta record
```

Keys use `/` separators for the metadata and blob namespaces. Both the meta
record and the blob are written with the same `{ ttl }` so they expire together; an expired id
surfaces as `document_expired` (see Error Contract).

### Tool input value types

- **`source`** (render_pdf): exactly one of the following keys must be present (Zod discriminated union on a literal `type` discriminant, or mutual exclusion enforced via `.refine()`):
  - `{ html: string }` — raw HTML string; the agent composes the full document markup.
  - `{ markdown: string }` — markdown string; server converts to HTML then renders.
  - `{ template: string, data: Record<string, unknown> }` — a Handlebars template string filled with `data`. `data` is `z.record(z.string(), z.unknown())`. Missing template keys are a `template_render_failed` error; extra keys in `data` are silently ignored.
  Providing zero keys, multiple keys, or `data` without a `template` → `invalid_source`.

- **`pageOptions`** (render_pdf): `size` (`'A4' | 'Letter' | 'Legal' | 'A3' | 'A5'` enum,
  default `'Letter'`), `orientation` (`'portrait' | 'landscape'`, default `'portrait'`),
  `margin` (object of optional `top|right|bottom|left` strings, each validated by
  `z.string().regex(/^\d+(\.\d+)?(px|pt|mm|cm|in)$/)` — e.g. `"10mm"`, `"0.5in"`, `"72pt"`),
  `header` / `footer` (optional strings supporting the interpolation tokens `{{page}}`,
  `{{total}}`, and `{{date}}` — e.g. `"Page {{page}} of {{total}}"`),
  `pageNumbers` (boolean, default `false`).
- **`sheets[]`** (export_spreadsheet): array of `{ name: string, rows: Record<string, string | number | boolean | null>[], columns?: ColumnSpec[] }`. `rows` values are plain JSON-serializable scalars; date values must be ISO 8601 strings when `type: 'date'` is declared in the column spec (exceljs converts them to Excel serial dates). An empty `rows[]` on any sheet is allowed (it produces an empty sheet with headers); `empty_workbook` fires only when `sheets[]` itself is empty.
- **Column spec** (export_spreadsheet): `key` (row-object property name), `header` (display
  label), `type` (`'string' | 'number' | 'date' | 'boolean'`, default `'string'`), `width`
  (column width in character units, `z.number().positive()`), `format`
  (Excel number/date format string, e.g. `'#,##0.00'`, `'yyyy-mm-dd'`).
- **`fields`** (fill_form): `Record<string, string | number | boolean>`. Exact names reserve their destinations across the entire map. Other keys resolve only when the union of exact last-segment and case-insensitive full-name matches contains one field, with no exact assignment or competing alias. Accepted aliases appear as `{ requested, resolved }` in `resolvedFields`; unknown, ambiguous and conflicting keys remain in `unmatchedFields`, in input order.
- **Form values.** Checkbox booleans retain their meaning; strings are trimmed and matched case-insensitively against checked (`true`, `1`, `yes`, `on`, `x`, `checked`) and unchecked (`false`, `0`, `no`, `off`, `unchecked`, empty) aliases. The exact PDF export string wins over generic string aliases; unchecked aliases win over a folded export match. Unknown values uncheck with a notice. Radios and option lists prefer exact choices, then unique case-insensitive choices. Dropdown custom text stays literal; a fixed-to-editable transition is reported before flattening.
- **Inventory values.** Unchecked boxes report `false`; unselected dropdowns and option lists report `[]`. Missing text/radio values are omitted, while an explicitly stored empty text string stays empty. Signature and button entries omit `value`. `page` is the 1-based page of the first widget, resolved through its page reference or annotation membership, and omitted when unknown.

---

## Services

No external API → the service layer is the bundled rendering stack plus the artifact store.

| Service | Responsibility | Key methods |
|---|---|---|
| `RenderService` | Owns PDF/xlsx rendering, AcroForm fill + flatten and read-only field inventory. Enforces rendering bounds and classifies failures. | `renderPdf(source, pageOptions, ctx)`, `renderSpreadsheet(sheets, ctx)`, `fillForm(sourceBytes, fields, flatten, ctx)` return document bytes; `listFormFields(sourceBytes, ctx)` returns inventory entries. |
| `DocumentStore` | Persists rendered artifacts and their metadata, mints document ids, enforces TTL, resolves ids back to bytes+metadata. Thin wrapper over `ctx.state` — meta record and base64 blob under separate tenant-scoped keys. | `put(result, ctx)` → `DocumentEnvelope`; `get(documentId, ctx)` → `{ meta, bytes }` or `null`; `buildEnvelope(meta, bytes, ctx)` |

Both follow the framework init/accessor pattern (`getRenderService()` / `getDocumentStore()`,
initialized in `setup()`). No DataCanvas or MirrorService is needed: a rendered document is one opaque blob, not a queryable table. URL-source connection fallback belongs to the fetch guard.

**Markdown path:** markdown → HTML via a small bundled converter, then through the same
HTML→PDF engine. Keeps one PDF code path; markdown is sugar over the HTML input.

**Why two `ctx.state` keys, not one record:** the bytes and the meta record live under
separate keys (`doc/blob/{id}` and `doc/meta/{id}`) so a read that only needs metadata never
pulls the multi-MB base64 blob with it. `ctx.state` is itself backed by `STORAGE_PROVIDER_TYPE`
(in-memory default → filesystem / R2 for durability), so swapping to a durable byte store is a
config change, not a `DocumentStore` rewrite. Both keys get the same TTL so they expire
atomically.

---

## Config

Server-specific env vars live in `src/config/server-config.ts` as a separate lazy-parsed Zod
schema (`getServerConfig()` / `parseEnvConfig`). Framework env vars (transport, auth,
`STORAGE_PROVIDER_TYPE`, `MCP_PUBLIC_URL`, logging) are unchanged.

| Env var | Purpose | Default | Required |
|---|---|---|---|
| `DOCGEN_DOCUMENT_TTL_SECONDS` | How long a rendered document is retrievable before it expires. | `900` (15 min) | No |
| `DOCGEN_MAX_DOCUMENT_BYTES` | Hard ceiling on a single rendered artifact; exceeding it aborts the render with `document_too_large`. | `26214400` (25 MB) | No |
| `DOCGEN_RENDER_TIMEOUT_MS` | Per-render wall-clock budget; exceeding it aborts with `render_timeout`. | `30000` | No |
| `DOCGEN_INLINE_MAX_BYTES` | Artifacts at or under this size are returned inline as base64; larger ones omit `inlineBase64` and must be fetched via the document resource. | `5242880` (5 MB) | No |
| `DOCGEN_PDF_ENGINE` | Selects the PDF rendering engine. `lightweight` (pdf-lib path) ships in v1; `chromium` is reserved for the deferred high-fidelity path and rejected at startup until implemented. | `lightweight` | No |

Framework env vars worth calling out (already provided, no code needed):

- **`STORAGE_PROVIDER_TYPE`** — `in-memory` (default; ephemeral, fine for stdio and
  single-instance hosting) → swap to `filesystem` or `cloudflare-r2` for durable bytes across
  restarts. `DocumentStore` is provider-agnostic.
- **`MCP_PUBLIC_URL`** — the public origin behind the TLS proxy. Reserved for the future HTTP
  download route that will populate `downloadUrl`; in v1 the field is never emitted and delivery
  is always via the resource URI and inline base64.

All booleans (none needed yet) would use `z.stringbool()`, never `z.coerce.boolean()`.
Numeric env vars use `z.coerce.number()`.

---

## Implementation Order

Each step is independently buildable and testable.

1. **Config** — `src/config/server-config.ts` with the five `DOCGEN_*` vars; wire
   `getServerConfig()`. Add the vars to `.env.example`, `server.json`, and `manifest.json`
   (`lint:packaging` verifies env-var name parity across `server.json` + `manifest.json`).
2. **`DocumentStore` service** — id minting, `put`/`get` over `ctx.state` (meta) + storage
   provider (bytes), TTL wiring, `DocumentEnvelope` builder. Testable with the in-memory
   provider and `createMockContext()`.
3. **`RenderService` — spreadsheet path first** (`exceljs`, fully deterministic, easiest to
   assert byte-for-byte structure) → **PDF path** (lightweight engine, HTML + markdown) →
   **form fill** (`pdf-lib` AcroForm fill + flatten, plus the URL-fetch branch for
   `sourcePdf.url`).
4. **Read tool + resource** — `docgen_get_document` and the `docgen://document/{documentId}`
   resource (shared `DocumentStore.get` + envelope builder; resource `format()` emits the
   base64 `blob` content item).
5. **Write tools** — `docgen_export_spreadsheet` → `docgen_render_pdf` →
   `docgen_fill_form` (in ascending complexity), each composing `RenderService` +
   `DocumentStore`.
6. **Polish** — `tool-defs-analysis`, `field-test`, `security-pass` (untrusted HTML and a
   caller-supplied fetch URL are real input sinks — see Known Limitations), `devcheck`.

Read tool + resource land before the write tools so the write tools' outputs have a verified
retrieval path to point at.

---

## Workflow Analysis

The `render/export/fill` tools are single-action renders, not multi-API workflows — the interesting
chains are **cross-tool** (id handoff) and **cross-server** (data → document). Each `render/export/fill`
internally runs: validate input → `RenderService.render*` (bounded by timeout + byte ceiling)
→ `DocumentStore.put` (mint id, write bytes + meta with TTL) → build + return envelope.

**1. Agent writes a report → PDF → human downloads.**

| # | Actor | Step |
|---|---|---|
| 1 | Agent | Composes styled HTML for the report. |
| 2 | Agent → `docgen_render_pdf` | `source: { html }`, `pageOptions: { size: 'Letter', pageNumbers: true }`. |
| 3 | Server | Renders, stores (TTL), returns `DocumentEnvelope` with `documentId`, `resourceUri`, and `inlineBase64` (when under the inline ceiling). |
| 4 | Human | Opens the inline file, or the client resolves `resourceUri` to fetch the bytes. |

**2. Cross-server: fetch data → spreadsheet.** This is the strongest demand path. The
**dependency hop is explicit:** the rows come from *another server's* tool output, not from
docgen.

| # | Actor | Step |
|---|---|---|
| 1 | Agent → (e.g.) `secedgar_get_financials` | Pulls financial rows. |
| 2 | Agent | Reshapes rows into `sheets[]` (one or more named sheets of row objects) + a column spec. |
| 3 | Agent → `docgen_export_spreadsheet` | Renders `.xlsx`. |
| 4 | Server | Stores, returns envelope (`sheetCount`, no `pageCount`). |
| 5 | Human | Downloads the workbook. |

**3. Fill a provided form.** First inspect an unfamiliar PDF with `docgen_list_form_fields`
using the same base64-or-URL source. Use its names, constraints and choice options in
`docgen_fill_form`; inspect unmatched names, resolved aliases and editability notices before treating the fill as complete. Keep the form unflattened when its values still need to be read back.

| # | Actor | Step |
|---|---|---|
| 1 | Agent → `docgen_fill_form` | `sourcePdf: { base64 }` (or `{ url }`), `fields: { ... }`, `flatten: true`. |
| 2 | Server | Resolves names, aggregates invalid assignments, fills fields, optionally flattens, then stores only a successful result. |
| 3 | Server | Returns the envelope, unmatched names, resolved aliases and dropdown editability changes, with notices for custom dropdown and unrecognized checkbox values. |

**4. Re-fetch by id (the explicit cross-tool hop).** `docgen_get_document` and the resource
**only resolve an id a `render/export/fill` tool minted** — there is no other way to obtain one. This
is the canonical "tool B's input comes from tool A's output" dependency, stated in the
`documentId` description.

| # | Actor | Step |
|---|---|---|
| 1 | Agent | Holds a `documentId` from an earlier `render/export/fill` call and needs its bytes again within the TTL. |
| 2 | Agent → `docgen_get_document` | `documentId`. |
| 3 | Server | Resolves via `DocumentStore.get`; returns the same envelope, or `document_expired` if the TTL lapsed. |

---

## Error Contract

The `render/export/fill` tools have a non-trivial typed failure surface (input gates + render bounds +
the form-fetch branch); declare it inline per tool via `errors: [...]` and throw with
`ctx.fail` or the matching service error factory. Framework baseline codes may bubble freely;
docgen's named semantic, fetch and timeout reasons are declared inline for recovery guidance.

| Tool | `reason` | Code | When | Recovery |
|---|---|---|---|---|
| all `render/export/fill` | `document_too_large` | `ValidationError` | Rendered artifact exceeded `DOCGEN_MAX_DOCUMENT_BYTES`. | Reduce content (fewer rows/pages, smaller images) and retry. |
| all `render/export/fill` | `render_timeout` | `Timeout` | Render exceeded `DOCGEN_RENDER_TIMEOUT_MS`. | Simplify the document or split it into smaller renders. |
| `docgen_render_pdf` | `invalid_source` | `ValidationError` | None of `html` / `markdown` / `template`+`data` was provided, more than one was, or `data` was supplied without a `template`. | Provide exactly one source form; `data` pairs only with `template`. |
| `docgen_render_pdf` | `template_render_failed` | `ValidationError` | The template referenced data keys absent from `data`, or the template was malformed. | Check the template's referenced fields against the `data` object. |
| `docgen_export_spreadsheet` | `empty_workbook` | `ValidationError` | `sheets[]` was empty (no sheets at all). | Provide at least one sheet. |
| `docgen_export_spreadsheet` | `invalid_sheet_name` | `ValidationError` | A worksheet name is blank, over 31 characters, contains `* ? : \ / [ ]`, begins or ends with an apostrophe, or duplicates another (case-insensitive). | Rename to a unique 1–31 character label without the forbidden characters. |
| both form tools | `invalid_source` | `ValidationError` | Neither source variant was supplied, or both were. | Provide exactly one base64-or-URL source. |
| both form tools | `not_a_form` | `ValidationError` | The source PDF has no AcroForm fields. | Confirm the PDF is a fillable form. |
| both form tools | `source_unfetchable` | `ServiceUnavailable` | The URL is blocked or did not return a fetchable PDF. | Use public HTTPS serving application/pdf or application/octet-stream with bytes starting with %PDF-, or use base64. |
| both form tools | `invalid_pdf_source` | `ValidationError` | The source is malformed base64 or invalid PDF bytes. | Re-encode and verify the PDF. |
| `docgen_fill_form` | `invalid_field_value` | `ValidationError` | One or more assignments exceed a text constraint, cannot render in their widget, name an unsupported field type, or do not resolve to a radio/list option. | Inspect `docgen_list_form_fields` and correct every reported assignment; no document was stored. |
| `docgen_list_form_fields` | `render_timeout` | `Timeout` | Inspection exceeded the configured deadline. | Use a smaller or simpler PDF and retry. |
| `docgen_get_document` | `document_expired` | `NotFound` | No stored document for that id — expired past TTL, or never existed. | Re-render with the originating `render/export/fill` tool; ids are not reusable across renders. |

`document_too_large` and `render_timeout` are declared on each `render/export/fill` tool's own
`errors[]` (per-tool locality — no shared constant), even though the `when`/`recovery` text is
identical.

Semantic errors use `ValidationError` (-32007); malformed tool arguments use `InvalidParams` (-32602). Field validation preserves values that pdf-lib can store without a widget and the text preparation its widget renderers support; unrelated PDF/template failures are not classified as invalid caller values.

**SSRF guard spec** (shared by both form tools' `sourcePdf.url` fetch path):

- Scheme must be `https` — `http` is rejected.
- Destination IP must not be in RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`), loopback (`127.0.0.0/8`), link-local (`169.254.0.0/16`), or `::1`.
  Every resolved candidate is checked at each hop, with equivalent IPv6 forms normalized and the full IPv6 link-local range covered. A fresh HTTPS socket connects only to a vetted address, preserving original TLS identity, SNI and HTTP Host.
- Response `Content-Type` is checked before reading the body: `application/pdf` is accepted; `application/octet-stream` is accepted only when the buffered body begins `%PDF-`. Other types are rejected without consuming the body.
- Response body is capped at `DOCGEN_MAX_DOCUMENT_BYTES`; an over-limit response is rejected
  before the full body is read.
- Redirects are followed up to a fixed limit (3); a redirect to a private IP triggers the same
  block as a direct private-IP request.
- Any guard violation surfaces as `source_unfetchable` with a `ServiceUnavailable` code.
- Deadlines and caller cancellation cover DNS, connection and body reading; an already-cancelled call opens no request.

---

## Output Design Notes

- **Dual-surface metadata.** The `DocumentEnvelope` fields all live in `output`, so
  the formatter renders them in both `structuredContent` and `content[]` — every client sees `documentId`, `resourceUri`, size, TTL, and the inline
  base64 (or its absence note when over the ceiling). `downloadUrl` is reserved and not emitted
  in v1, so `format()` always renders its absence note. The block leads with an action-specific
  sentence ("Rendered a 3-page PDF (142 KB).") followed by the labeled fields.
- **Inline vs. link by size.** `inlineBase64` is populated only when `byteSize ≤
  DOCGEN_INLINE_MAX_BYTES`; above that the field is omitted and `format()` states the doc is
  available via the document resource. This keeps a 20 MB workbook from being base64-inlined into a
  tool result. The bytes never ride as a `ctx.content` media block — that helper is
  image/audio only, so arbitrary document bytes go inline-in-`output` (small) or via the
  resource `blob` (always).
- **`unmatchedFields[]`** (fill_form) communicates partial application: the form was filled
  with what matched, and the agent is told which field names didn't land — it can correct and
  re-render rather than assuming a clean fill.
- **`resolvedFields[]` and `madeEditableFields[]`** disclose name resolution and dropdown changes. The latter records the transition before flattening; a notice names the custom value. Unknown checkbox assignments also carry a notice. These fields and notices appear on both output surfaces.
- **No truncation / no spill.** A document is one opaque artifact, not a row collection, so
  there is no DataCanvas spill and no list truncation — the "large result" axis here is *byte
  size of one blob*, handled by the inline-vs-link threshold above, not by paging.
- **Enrichment.** Render stats the agent reasons with but that aren't the document itself
  (e.g. `engine: 'lightweight'`, a `degraded: true` flag when the lightweight engine dropped
  unsupported CSS or replaced text characters — see Known Limitations) ride in an `enrichment` block via `ctx.enrich`, so
  they reach both client surfaces without bloating the envelope.

---

## Design Decisions

- **Preserve custom dropdown text.** Case-insensitive normalization applies to finite radio/list choices only. Dropdowns already accept literal custom text, so normalizing it would change a valid stored value and hide an editability transition.
- **Exact assignments precede aliases.** Resolve aliases from the full field inventory and leave collisions unmatched. Input ordering must never let a guessed alias overwrite an exact assignment.
- **Three `render/export/fill` tools, not one `mode`-switched tool.** idea.md floated a single
  `convert(mode: 'pdf' | 'xlsx' | 'fill')`. The inputs diverge too far — content vs. tabular
  rows vs. source-PDF + field map share almost no schema — so a mode switch would force a
  union input where most fields are irrelevant per mode. Three focused tools read cleaner and
  validate tighter. (`docgen_get_document` is the fourth, a pure read.)
- **Tool verbs name what each tool does.** The earlier sketch used a uniform `convert_`
  prefix, but `convert` reads as a format-transcode verb when these tools really *render*
  (markup→PDF), *export* (data→xlsx), and *fill* (a form). v1 ships the accurate verbs —
  `docgen_render_pdf`, `docgen_export_spreadsheet`, `docgen_fill_form` (`docgen_get_document`
  unchanged, a pure read). A weaker model picks the right tool faster when the verb names the
  action.
- **Lightweight engine ships in v1; Chromium high-fidelity is deferred behind
  `DOCGEN_PDF_ENGINE`.** This is the "one big call" idea.md named (fidelity vs. image weight),
  resolved toward **portability first**. The `pdf-lib`/programmatic path keeps the Docker
  image light and the server Workers-eligible; headless Chromium gives real CSS fidelity but
  bloats the image and drops the Workers target. v1 covers the common cases (templated
  invoices/reports/letters, structured layout, markdown); arbitrary full-CSS HTML fidelity is
  the deferred `chromium` engine. Shipping the flag now (rejected at startup until
  implemented) reserves the seam so adding Chromium later is additive, not a refactor.
- **One shared `DocumentEnvelope` across all four tools.** Identical delivery shape means the
  three writers and the reader are interchangeable to the agent, and the resource-URI vs.
  inline-base64 split is one decision in one place rather than per-tool.
- **Bytes and metadata under two separate `ctx.state` keys.** The small meta record and the
  base64 blob are stored independently (`doc/meta/{id}`, `doc/blob/{id}`) so a metadata read
  never drags the multi-MB blob with it. `ctx.state` is provider-backed (`STORAGE_PROVIDER_TYPE`),
  so durability is a config swap. Both written with the same TTL so they expire atomically.
- **`documentId` is opaque and only obtainable from a `render/export/fill` output.** Not derived from
  input, not guessable — stated in the field description so the agent knows the *only* way to
  get one is to render first. This is the explicit cross-tool dependency the read tool +
  resource depend on.
- **TTL-bounded, restart-ephemeral by default.** Outputs are downloads, not records — nothing
  meaningful needs to survive a restart, so the in-memory provider is the default and a
  durable provider is an opt-in config swap. Bounds the server's memory footprint without a
  cleanup job (TTL eviction is the provider's).
- **`openWorldHint: false` even for `fill_form` with a URL.** The URL is a caller-named,
  validated input fetched once (behind an SSRF guard), not open-world API discovery — the
  hint reflects that the tool's *behavior* is deterministic given its inputs.
- **Document delivery and workflow resources.** The document-by-id template provides raw
  artifact bytes, including those above the inline limit. The published `docgen-guide`
  skill teaches review of the saved PDF before flattening. No prompt is registered.

---

## Known Limitations

- **Lightweight-engine fidelity gap (v1).** The `pdf-lib`/programmatic path does not render
  arbitrary CSS — complex flex/grid layouts, web fonts, and advanced page-break control are
  constrained. Agents needing pixel-faithful full-CSS HTML→PDF wait for the deferred
  `chromium` engine. The handler surfaces a `degraded: true` enrichment flag when it drops
  unsupported styling or replaces characters with `?` on any text surface, including headers and footers. Existing smart-punctuation transliteration and supported Latin-1 remain non-degraded absent another trigger.
- **Untrusted HTML is an input sink.** `docgen_render_pdf` renders caller-supplied HTML. The
  lightweight engine has a far smaller attack surface than a real browser (no JS execution, no
  network fetches from the document), but the `security-pass` step must confirm no
  remote-resource fetch, no local-file access, and no script execution from document content.
- **Form-fetch SSRF surface.** Both form tools fetch caller-named URL sources through the guard: public HTTPS destinations, vetted connections at every redirect, MIME checks and a byte ceiling. Generic binary responses also require a `%PDF-` prefix. Base64 input avoids the fetch entirely.
- **AcroForm only, no XFA.** Form fill targets standard AcroForm fields. XFA-based forms
  (some government PDFs) are not supported by `pdf-lib`; `not_a_form` fires when no fillable
  AcroForm is present. XFA-only PDFs also trigger `not_a_form` — there is no distinction
  between a flat PDF and an XFA-only PDF from the error surface.
- **Field discovery does not expand filling support.** Signature and button fields are inventory entries; signing and button actions remain out of scope.
- **Ephemeral by default.** With the in-memory provider, a restart drops all stored documents;
  ids minted before the restart return `document_expired`. Durable retention requires a
  filesystem/R2 provider. This is intended (downloads, not records) but is a real constraint
  for any caller assuming persistence.
- **No `.docx`, no diagram/chart rendering, no document parsing.** Out of scope by design (see
  Requirements); not a gap to be closed without a deliberate scope expansion.
- **Inline-base64 ceiling.** Documents above `DOCGEN_INLINE_MAX_BYTES` are not returned inline;
  a stdio client with no resource support must use a provider/path it can read, or accept the
  resource path. The threshold trades context budget against one-round-trip delivery.

---

## v1 Scope vs. Deferred

**Ships in v1**

- `docgen_render_pdf` (HTML / markdown / template+data) via the **lightweight** engine
- `docgen_export_spreadsheet` (multi-sheet `.xlsx`, column spec)
- `docgen_fill_form` (AcroForm fill + flatten; base64 and URL source)
- `docgen_list_form_fields` (read-only AcroForm inventory; same base64 and URL source)
- `docgen_get_document` (re-fetch by id)
- `docgen://document/{documentId}` resource (blob + metadata)
- `skill://docgen-guide/SKILL.md` resource and Skills extension discovery
- Shared `DocumentEnvelope`; dual delivery (document resource + inline base64)
- Tenant-scoped, TTL-bounded storage (`DocumentStore` over `ctx.state` + storage provider)
- Render bounds (`DOCGEN_MAX_DOCUMENT_BYTES`, `DOCGEN_RENDER_TIMEOUT_MS`) and the typed error
  contract
- SSRF guard on the form-fetch path

**Deferred**

- **High-fidelity HTML→PDF via headless Chromium** (`DOCGEN_PDF_ENGINE=chromium`) — full CSS,
  web fonts, precise page breaks, headers/footers. The flag and seam exist in v1; the engine
  does not. Drops the Workers target when enabled (Node-only), mirroring the runtime split
  other heavy servers carry.
- **Async render + polling** for the heavy Chromium path — `docgen_get_document` already
  supports the poll-for-completion shape; the async render itself is deferred with the engine.
- **`.docx` output** — only if real demand appears.
- **Prompt templates** for common document types (invoice, letter) — sugar, not workflow.
