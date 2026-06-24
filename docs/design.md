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
| `docgen_fill_form` | Fill the AcroForm fields of a supplied PDF, optionally flatten it. | `false` | `false` | `sourcePdf` (oneOf: `base64` \| `url`), `fields` (name→value map), `flatten` | `DocumentEnvelope` + `unmatchedFields[]` |
| `docgen_get_document` | Re-fetch a previously rendered document by the id a `render/export/fill` tool returned. | `true` | `false` | `documentId` | `DocumentEnvelope` (same shape the originating tool returned) |

`readOnlyHint` is `false` on the three `render/export/fill` tools because each **writes** a stored
artifact (tenant-scoped storage, TTL-bounded) as a side effect — even though no external
system is mutated. `docgen_get_document` is a pure read. `openWorldHint` is `false`
everywhere: all rendering is local and deterministic, no live external API is contacted at
render time. (`docgen_fill_form` with `sourcePdf.url` fetches one caller-named URL — an
explicit input, not open-world discovery; see Design Decisions.)

### Resources

| URI template | Returns |
|---|---|
| `docgen://document/{documentId}` | The rendered document — two content items: (1) a `blob` with `mimeType` set to the document's real mime type and the raw bytes as base64, and (2) a `text` item containing a JSON metadata block (`{ documentId, byteSize, pageCount?, sheetCount?, createdAt, ttlSecondsRemaining }`). `documentId` is the id returned by any `render/export/fill` tool. Readable until the TTL expires, then `notFound`. |

The resource is the stable-URI delivery surface: a host that supports resources resolves
`docgen://document/{id}` to fetch the bytes directly. `docgen_get_document` is the
tool-only twin (most clients are tool-only) — same backing store, same envelope. Neither
re-renders; both read the stored artifact.

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
- Deliver every output two ways from one envelope: a **resource URI / download URL** (hosted
  path) and **inline base64** (local/stdio path), carrying identical metadata.
- Re-fetch a stored document by id until its TTL expires.

**Non-functional**

- **No external API → no resilience layer.** No upstream retry/backoff. The server-as-service
  state questions apply instead (below).
- **Bounded renders.** A per-document byte ceiling and a render timeout bound a runaway
  render (a pathological HTML page, an enormous sheet set). Exceeding either is a typed,
  recoverable error, not a hang.
- **Ephemeral storage.** Rendered artifacts live in tenant-scoped storage with a short TTL
  and survive nothing meaningful across a restart (in-memory provider) — outputs are
  download-and-go. A durable provider (filesystem / R2) is a config swap, not a code change.
- **Tenant isolation.** A document id minted for one tenant resolves only for that tenant —
  enforced by `ctx.state` tenant-prefixing; a leaked id does not cross the tenant boundary.
- **Hosting is an advantage, not a tax.** Hosted docgen returns a URL the human clicks —
  exactly the delivery mechanism that makes artifact generation useful. The local/stdio path
  round-trips base64 through the client.

**Out of scope (v1)**

- **`.docx`** — faithful Word output is far harder than PDF/xlsx and lower-value for agents.
  Deferred until real demand appears.
- **Diagrams / charts / SVG** — already rendered client-side; deliberately not docgen's job.
- **Document *reading*/parsing** — docgen writes bytes, it does not extract text or parse
  uploaded documents. (This is why the name is `docgen`, not `document` — see idea.md.)
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
  downloadUrl?: string;      // absolute https URL to the bytes; present only in HTTP/hosted
                             //   mode (derived from MCP_PUBLIC_URL). Omitted in stdio.
  mimeType: DocumentMime;    // 'application/pdf'
                             //   | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  byteSize: number;          // size of the rendered artifact in bytes — z.number().int().nonnegative()
  pageCount?: number;        // PDF only (render_pdf, fill_form) — z.number().int().positive()
  sheetCount?: number;       // xlsx only (export_spreadsheet) — z.number().int().positive()
  ttlSecondsRemaining: number; // seconds until the stored artifact expires — z.number().int().nonnegative()
  createdAt: string;         // ISO 8601 UTC (e.g. "2026-06-23T12:00:00.000Z")
  inlineBase64?: string;     // the bytes, base64. Present (z.string().optional()) when the
                             //   artifact is at or under DOCGEN_INLINE_MAX_BYTES; field is
                             //   absent (not empty string) when larger. Fetch via resource/URL
                             //   when omitted. See Output Design Notes.
}
```

`DocumentMime` is a Zod enum (two literals in v1), never a bare `string` — it constrains the
output and documents exactly which formats exist.

### Stored record (internal, tenant-scoped)

What persists between a `render/export/fill` call and a later `docgen_get_document` / resource read.
Split into a **lightweight metadata record** (`ctx.state`, serializable KV) and the **bytes**
(a storage provider key) so the KV layer never holds a multi-MB base64 string:

```ts
// ctx.state key: `doc:meta:{documentId}`  (tenant-prefixed automatically)
interface StoredDocumentMeta {
  documentId: string;
  blobKey: string;           // storage-provider key holding the raw bytes
  mimeType: DocumentMime;
  byteSize: number;
  pageCount?: number;
  sheetCount?: number;
  createdAt: string;
}
// bytes: storage-provider object at `blobKey`, written with the same TTL as the meta record
```

Both the meta record and the blob are written with the same `{ ttl }` so they expire
together; an expired id surfaces as `document_expired` (see Error Contract).

### Tool input value types

- **`source`** (render_pdf): exactly one of the following keys must be present (Zod discriminated union on a literal `type` discriminant, or mutual exclusion enforced via `.refine()`):
  - `{ html: string }` — raw HTML string; the agent composes the full document markup.
  - `{ markdown: string }` — markdown string; server converts to HTML then renders.
  - `{ template: string, data: Record<string, unknown> }` — a Handlebars template string filled with `data`. `data` is `z.record(z.string(), z.unknown())`. Missing template keys are a `template_render_failed` error; extra keys in `data` are silently ignored.
  Providing zero keys or multiple keys → `invalid_source`.

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
- **`fields`** (fill_form): `Record<string, string | number | boolean>` — AcroForm field
  name → value. **Field names must match the PDF's internal AcroForm field names exactly
  (case-sensitive).** Obtain field names from the person or system that supplied the PDF — the
  form's field names are not exposed by docgen. Unmatched names are returned in
  `unmatchedFields[]` rather than causing a failure; re-render with corrected names.

---

## Services

No external API → the service layer is the bundled rendering stack plus the artifact store.

| Service | Responsibility | Key methods |
|---|---|---|
| `RenderService` | Owns the rendering stack. PDF from HTML/markdown (lightweight engine in v1), `.xlsx` from sheet specs, AcroForm fill + flatten. Enforces the byte ceiling and render timeout; classifies render failures. | `renderPdf(source, pageOptions, ctx)`, `renderSpreadsheet(sheets, ctx)`, `fillForm(sourceBytes, fields, flatten, ctx)` — each returns `{ bytes, mimeType, pageCount?/sheetCount? }` |
| `DocumentStore` | Persists rendered artifacts and their metadata, mints document ids, enforces TTL, resolves ids back to bytes+metadata. Thin wrapper over `ctx.state` (metadata) + the storage provider (bytes). | `put(bytes, meta, ctx)` → `documentId`; `get(documentId, ctx)` → `StoredDocumentMeta + bytes` or `null`; builds the `DocumentEnvelope` |

Both follow the framework init/accessor pattern (`getRenderService()` / `getDocumentStore()`,
initialized in `setup()`). No DataCanvas, no MirrorService, no retry layer — there is no
upstream and no analytical row set to spill (a rendered document is one opaque blob, not a
queryable table).

**Markdown path:** markdown → HTML via a small bundled converter, then through the same
HTML→PDF engine. Keeps one PDF code path; markdown is sugar over the HTML input.

**Why a storage provider for bytes, not `ctx.state` alone:** `ctx.state` is a serializable KV
designed for lightweight values; a multi-MB document base64-encoded into KV is the wrong
shape. The storage provider (`STORAGE_PROVIDER_TYPE`) already abstracts in-memory /
filesystem / R2, so `DocumentStore` writes bytes there and keeps only the small meta record
in `ctx.state`. Both get the same TTL.

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
| `DOCGEN_INLINE_MAX_BYTES` | Artifacts at or under this size are returned inline as base64; larger ones omit `inlineBase64` and must be fetched via the resource/URL. | `5242880` (5 MB) | No |
| `DOCGEN_PDF_ENGINE` | Selects the PDF rendering engine. `lightweight` (pdf-lib path) ships in v1; `chromium` is reserved for the deferred high-fidelity path and rejected at startup until implemented. | `lightweight` | No |

Framework env vars worth calling out (already provided, no code needed):

- **`STORAGE_PROVIDER_TYPE`** — `in-memory` (default; ephemeral, fine for stdio and
  single-instance hosting) → swap to `filesystem` or `cloudflare-r2` for durable bytes across
  restarts. `DocumentStore` is provider-agnostic.
- **`MCP_PUBLIC_URL`** — the public origin behind the TLS proxy; `downloadUrl` is derived from
  it. Unset (stdio) → `downloadUrl` is omitted and delivery is inline/resource only.

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
| 3 | Server | Renders, stores (TTL), returns `DocumentEnvelope` with `documentId`, `resourceUri`, `downloadUrl` (hosted) or `inlineBase64` (stdio). |
| 4 | Human | Clicks `downloadUrl`, or the client opens the inline file. |

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

**3. Fill a provided form.** The **field names are an input the agent must already hold**
(from the form's definition / the human) — docgen v1 does not discover them. Use
`unmatchedFields[]` in the response to iteratively correct misnamed fields; the deferred
`docgen_list_form_fields` tool (see v1 Scope vs. Deferred) will expose the field inventory
when available.

| # | Actor | Step |
|---|---|---|
| 1 | Agent → `docgen_fill_form` | `sourcePdf: { base64 }` (or `{ url }`), `fields: { ... }`, `flatten: true`. |
| 2 | Server | Loads the PDF, fills matching AcroForm fields, flattens, stores. |
| 3 | Server | Returns envelope + `unmatchedFields[]` (field names in the map that had no AcroForm counterpart — the agent's signal to fix names). |

**4. Re-fetch by id (the explicit cross-tool hop).** `docgen_get_document` and the resource
**only resolve an id a `render/export/fill` tool minted** — there is no other way to obtain one. This
is the canonical "tool B's input comes from tool A's output" dependency, stated in the
`documentId` description.

| # | Actor | Step |
|---|---|---|
| 1 | Agent | Holds a `documentId` from an earlier `render/export/fill` call (inline copy dropped, or URL expired-but-within-TTL). |
| 2 | Agent → `docgen_get_document` | `documentId`. |
| 3 | Server | Resolves via `DocumentStore.get`; returns the same envelope, or `document_expired` if the TTL lapsed. |

---

## Error Contract

The `render/export/fill` tools have a non-trivial typed failure surface (input gates + render bounds +
the form-fetch branch); declare it inline per tool via `errors: [...]` and throw with
`ctx.fail`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`,
`ValidationError`, `SerializationError`) bubble freely and are not declared.

| Tool | `reason` | Code | When | Recovery |
|---|---|---|---|---|
| all `render/export/fill` | `document_too_large` | `InvalidParams` | Rendered artifact exceeded `DOCGEN_MAX_DOCUMENT_BYTES`. | Reduce content (fewer rows/pages, smaller images) and retry. |
| all `render/export/fill` | `render_timeout` | `Timeout` | Render exceeded `DOCGEN_RENDER_TIMEOUT_MS`. | Simplify the document or split it into smaller renders. |
| `docgen_render_pdf` | `invalid_source` | `InvalidParams` | None of `html` / `markdown` / `template`+`data` was provided, or more than one was. | Provide exactly one source form. |
| `docgen_render_pdf` | `template_render_failed` | `InvalidParams` | The template referenced data keys absent from `data`, or the template was malformed. | Check the template's referenced fields against the `data` object. |
| `docgen_export_spreadsheet` | `empty_workbook` | `InvalidParams` | `sheets[]` was empty (no sheets at all). | Provide at least one sheet. |
| `docgen_fill_form` | `not_a_form` | `InvalidParams` | The source PDF has no AcroForm fields to fill. | Confirm the PDF is a fillable form; a flat PDF cannot be filled. |
| `docgen_fill_form` | `source_unfetchable` | `ServiceUnavailable` | `sourcePdf.url` did not return a fetchable PDF (non-2xx, not a PDF, response over `DOCGEN_MAX_DOCUMENT_BYTES`, or blocked by SSRF guard — see below). | Verify the URL is public, reachable, and serves `application/pdf`; or pass the PDF as base64 to skip the fetch entirely. |
| `docgen_fill_form` | `invalid_pdf_source` | `InvalidParams` | `sourcePdf.base64` was provided but is not a valid base64-encoded PDF. | Re-encode the PDF as base64 and verify the content starts with `JVBERi` (the base64 prefix for `%PDF-`). |
| `docgen_get_document` | `document_expired` | `NotFound` | No stored document for that id — expired past TTL, or never existed. | Re-render with the originating `render/export/fill` tool; ids are not reusable across renders. |

`document_too_large` and `render_timeout` are declared on each `render/export/fill` tool's own
`errors[]` (per-tool locality — no shared constant), even though the `when`/`recovery` text is
identical.

**SSRF guard spec** (enforced on the `sourcePdf.url` fetch path in `fill_form`):

- Scheme must be `https` — `http` is rejected.
- Destination IP must not be in RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`), loopback (`127.0.0.0/8`), link-local (`169.254.0.0/16`), or `::1`.
  DNS resolution happens inside the guard — the resolved IP is checked, not just the hostname.
- Response `Content-Type` must be `application/pdf` (checked before buffering the body).
- Response body is capped at `DOCGEN_MAX_DOCUMENT_BYTES`; an over-limit response is rejected
  before the full body is read.
- Redirects are followed up to a fixed limit (3); a redirect to a private IP triggers the same
  block as a direct private-IP request.
- Any guard violation surfaces as `source_unfetchable` with a `ServiceUnavailable` code.

---

## Output Design Notes

- **Dual-surface metadata.** The `DocumentEnvelope` fields all live in `output`, so
  `format-parity` drags them into both `structuredContent` and the `format()` markdown twin
  automatically — every client sees `documentId`, `resourceUri`, `downloadUrl`/inline note,
  size, and TTL. `format()` renders a human-readable block ("Rendered a 3-page PDF (142 KB).
  Download: …  · expires in 15 min").
- **Inline vs. link by size.** `inlineBase64` is populated only when `byteSize ≤
  DOCGEN_INLINE_MAX_BYTES`; above that the field is omitted and `format()` states the doc is
  available via the resource/URL. This keeps a 20 MB workbook from being base64-inlined into a
  tool result. The bytes never ride as a `ctx.content` media block — that helper is
  image/audio only, so arbitrary document bytes go inline-in-`output` (small) or via the
  resource `blob` (always).
- **`unmatchedFields[]`** (fill_form) communicates partial application: the form was filled
  with what matched, and the agent is told which field names didn't land — it can correct and
  re-render rather than assuming a clean fill.
- **No truncation / no spill.** A document is one opaque artifact, not a row collection, so
  there is no DataCanvas spill and no list truncation — the "large result" axis here is *byte
  size of one blob*, handled by the inline-vs-link threshold above, not by paging.
- **Enrichment.** Render stats the agent reasons with but that aren't the document itself
  (e.g. `engine: 'lightweight'`, a `degraded: true` flag when the lightweight engine dropped
  unsupported CSS — see Known Limitations) ride in an `enrichment` block via `ctx.enrich`, so
  they reach both client surfaces without bloating the envelope.

---

## Design Decisions

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
  three writers and the reader are interchangeable to the agent, and the hosted-URL vs.
  inline-base64 split is one decision in one place rather than per-tool.
- **Bytes in a storage provider, metadata in `ctx.state`.** Keeps the KV layer holding small
  records and routes multi-MB blobs through the provider built for them
  (`STORAGE_PROVIDER_TYPE`). Both written with the same TTL so they expire atomically.
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
- **Resources kept (one), prompts dropped (zero).** The document-by-id resource is the
  canonical stable-URI artifact delivery and pairs naturally with `docgen_get_document` for
  tool-only clients. No prompt earns its place in an action-only surface.

---

## Known Limitations

- **Lightweight-engine fidelity gap (v1).** The `pdf-lib`/programmatic path does not render
  arbitrary CSS — complex flex/grid layouts, web fonts, and advanced page-break control are
  constrained. Agents needing pixel-faithful full-CSS HTML→PDF wait for the deferred
  `chromium` engine. The handler surfaces a `degraded: true` enrichment flag when it drops
  unsupported styling so the agent isn't misled about fidelity.
- **Untrusted HTML is an input sink.** `docgen_render_pdf` renders caller-supplied HTML. The
  lightweight engine has a far smaller attack surface than a real browser (no JS execution, no
  network fetches from the document), but the `security-pass` step must confirm no
  remote-resource fetch, no local-file access, and no script execution from document content.
- **Form-fetch SSRF surface.** `docgen_fill_form` with `sourcePdf.url` fetches a
  caller-named URL. This needs an SSRF guard (block private/loopback/link-local ranges,
  require `https`, cap response size, verify `application/pdf`) before it ships — tracked into
  the `security-pass` step. Base64 input avoids the fetch entirely.
- **AcroForm only, no XFA.** Form fill targets standard AcroForm fields. XFA-based forms
  (some government PDFs) are not supported by `pdf-lib`; `not_a_form` fires when no fillable
  AcroForm is present. XFA-only PDFs also trigger `not_a_form` — there is no distinction
  between a flat PDF and an XFA-only PDF from the error surface.
- **Field name discovery is out of scope in v1.** Agents filling a form they have not seen
  before must obtain field names from the human or from a trusted description of the form.
  The `unmatchedFields[]` return provides a correction loop. A `docgen_list_form_fields` tool
  is deferred (see v1 Scope vs. Deferred).
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
- `docgen_get_document` (re-fetch by id)
- `docgen://document/{documentId}` resource (blob + metadata)
- Shared `DocumentEnvelope`; dual delivery (resource/URL + inline base64)
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
- **`docgen_list_form_fields`** (DX enhancement, not P0) — accepts the same `sourcePdf`
  input as `fill_form` (base64 or URL) and returns the AcroForm field inventory: field
  name, type (`text | checkbox | radio | select | signature`), and whether it is required.
  Useful when the agent does not already know the form's field names. Deferred: the
  fill-and-correct loop via `unmatchedFields[]` is sufficient for v1; add this tool when
  form-fill adoption shows that agents commonly mis-name fields on the first attempt.
