# docgen-mcp-server — Idea & Design

Document generation. The reason this earns an agent's call isn't capability — it's that **I can't emit bytes.** I can produce a perfect invoice's HTML, a full report's prose, or a clean data table in text; I cannot type a `.pdf` or an `.xlsx` file. This server is the renderer: structured content (or a template + data) in, a downloadable binary document out. It's the one idea from the brainstorm that clears the agent's-eyes bar squarely on criterion (c) — artifact bytes the model can't produce as tokens.

**Scope is binary documents, deliberately not diagrams.** Mermaid, SVG, HTML, and charts are already rendered client-side by Claude artifacts and most rich clients, so a "diagram renderer" is mostly mooted. The un-mootable core is a file a human downloads and keeps: a PDF, a spreadsheet, a filled form.

**Audience:** any agent producing a document *for the human behind it* — invoices, reports, letters, certificates, filled PDF forms, exported spreadsheets. Honest caveat: demand is human-driven (the human wants the file), not agent-reasoning-driven, so call volume is lower and more bursty than a data server's. It earns its place by being the only path to the output, not by being reached for constantly.

## User Goals

- Turn HTML/CSS the agent already wrote into a pixel-faithful PDF
- Render a templated document (invoice, report, letter) from structured data
- Export tabular data to a real `.xlsx` with headers, types, and multiple sheets
- Fill the fields of a provided PDF form and flatten it
- Hand the human a download link (hosted) or an inline file (local) — not a wall of text it can't use

## Rendering engine (service layer)

No external API — the "service" is the bundled rendering stack. The central build-time decision is the fidelity/weight tradeoff:

| Path | Engine | Fidelity | Cost |
|:-----|:-------|:---------|:-----|
| HTML → PDF (high fidelity) | headless Chromium (Playwright/Puppeteer) | Full CSS, fonts, page breaks, headers/footers | Heavy Docker image (~Chromium); **Node-only, no Workers** |
| Programmatic PDF (lightweight) | `pdf-lib` / `pdfkit` / `@react-pdf/renderer` | Limited layout, own model; no arbitrary CSS | Light; portable |
| PDF form fill | `pdf-lib` | AcroForm fill + flatten | Light |
| Spreadsheet | `exceljs` (or SheetJS) | Sheets, headers, number/date formats, basic styling | Light |

## Tool Surface (sketch)

```
docgen_render_pdf       — the flagship. Input is ONE of:
                           - content: HTML (the agent's strength — it writes styled
                             HTML, the server prints it) or markdown
                           - template + data: a Handlebars/HTML template filled with
                             a structured data object (server owns layout)
                           Options: page size, orientation, margins, header/footer,
                           page numbers. Output: the document as a stored resource
                           (download URL + metadata) and/or inline base64 — see the
                           binary-return note below.

docgen_export_spreadsheet — tabular data → .xlsx. Accepts one or more named sheets,
                           each an array of row objects; optional column spec (header
                           label, type, width, number/date format). Output: same
                           delivery shape as render_pdf.

docgen_fill_form      — a source PDF with AcroForm fields (provided as base64 or a
                           URL) + a field→value map → filled, optionally flattened PDF.
                           For tax forms, applications, templates the human already has.

docgen_get_document      — retrieve a previously rendered document by its resource ID
                           (the id returned by the render/export/fill tools). Returns the same
                           delivery envelope: download URL, mime type, byte size, TTL
                           remaining. Needed for async renders (heavy Chromium path)
                           where the caller polls for completion, and for re-fetching a
                           URL that has expired.
```

A `mode`-consolidated single tool (`mode: 'pdf' | 'xlsx' | 'fill'`) is an alternative, but the inputs diverge enough (content vs. tabular rows vs. source-PDF+fields) that three tools probably read cleaner. Decide at design time.

## Design Notes

- **The crux is binary delivery over MCP.** Tool results are text/structured content; a PDF isn't. Two paths: (1) **hosted** — render → store in tenant-scoped storage with a short TTL → return a download URL + a resource URI + metadata (page count, byte size, mime). The human clicks the link. (2) **stdio/local** — return inline base64 as an `image`/`resource` content block, or write to a path the client can open. Design the output schema so both surfaces carry the same metadata; the bytes ride as a resource link or blob.
- **Hosting is an advantage here, not a tax** — uniquely among the brainstorm ideas. A hosted docgen returns a URL the human downloads, which is exactly the delivery mechanism that makes artifact generation useful. Local/stdio has to round-trip base64 through the client. The artifact-delivery story is *better* hosted.
- **Play to the agent's strength: HTML in.** The model is excellent at writing styled HTML/CSS. "Agent writes HTML → server prints to PDF" beats "server owns a rigid template" for most one-off documents. Keep template+data as the path for repeated, layout-owned docs.
- **Fidelity vs. image weight is the one big call.** Chromium gives real CSS fidelity but bloats the image and drops the Workers target (mirror the runtime split whois documents for its TCP path). A pdf-lib/react-pdf path stays light and portable but constrains layout. Could ship lightweight first, add a Chromium-backed high-fidelity mode later behind a flag.
- **Composes with every data-returning server.** The natural chain is "fetch data → render a document": a `secedgar` financial summary, a `usaspending` award report, a `census` table → a PDF/xlsx the human keeps. That cross-server pairing is the strongest demand signal — docgen is the export stage other servers don't have.
- **No external calls, so no resilience layer** — the server-as-service state questions apply instead: rendered-file TTL, tenant-scoped storage, max document size/timeout to bound a runaway render, and what (if anything) survives a restart (probably nothing — outputs are ephemeral downloads).
- **`.docx` is tempting and a trap.** Faithful Word output is far harder than PDF/xlsx and lower-value for agents. Defer unless real demand shows up.
- **Naming.** `docgen-mcp-server` is short and clear. `document-mcp-server` reads broader (implies reading/parsing too, which is out of scope); keep `docgen`.
