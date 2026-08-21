# Developer Protocol

**Server:** docgen-mcp-server
**Version:** 0.2.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.12.3`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What this server does

docgen-mcp-server renders structured agent content into downloadable binary documents. The agent composes the content; the server prints the file a human downloads. Every render is stored tenant-scoped under a TTL and handed back as a `DocumentEnvelope` (a `documentId` + resource URI + inline base64 when small enough); a later call re-fetches it within the TTL.

**Surface:**

| Definition | Kind | What it does |
|:-----------|:-----|:-------------|
| `docgen_render_pdf` | tool | HTML / markdown / `{{template}}+data` → PDF (lightweight pdf-lib engine). Sets a `degraded` enrichment flag when it drops unsupported styling (CSS, images, scripts). |
| `docgen_export_spreadsheet` | tool | One or more named row sheets → `.xlsx` (exceljs), with an optional per-column type/format spec. |
| `docgen_fill_form` | tool | Fill (and optionally flatten) the AcroForm fields of a supplied PDF — source as `{ base64 }` or an `{ url }` fetched behind an SSRF guard. Unmatched field names come back in `unmatchedFields[]`. |
| `docgen_get_document` | tool | Re-fetch a previously rendered document by its `documentId`. Pure read; `document_expired` once the TTL lapses. |
| `docgen://document/{documentId}` | resource | The stable-URI delivery surface — a byte blob (real mime type) + a JSON metadata block. |

**Services (`src/services/document/`):**

- `render-service.ts` — the bundled rendering stack (PDF, xlsx, form-fill); enforces the byte ceiling + per-render timeout and classifies failures into the typed reasons the tools declare.
- `document-store.ts` — mints opaque ids, persists bytes + metadata via tenant-scoped `ctx.state` under a shared TTL, builds the envelope. A leaked id never crosses the tenant boundary.
- `fetch-guard.ts` — SSRF-guarded PDF fetcher for the `fill_form` URL source: https-only, blocks private/loopback/link-local/metadata destinations by resolving DNS and checking the resolved IP, re-validates every redirect hop, enforces `application/pdf`, caps the body. Every failure path is normalized to a leak-free `source_unfetchable` error.
- `html-blocks.ts` — reduces HTML/markdown to a linear block model for the lightweight engine (no JS execution, no remote-resource fetch); flags `degraded` for anything it can't render.
- `format-envelope.ts` / `types.ts` / `render-types.ts` — the shared `DocumentEnvelope` formatter, domain types, and render-input schemas.

**Config (`src/config/server-config.ts`):** the `DOCGEN_*` env vars — document TTL, byte ceiling, render timeout, inline threshold, and the PDF engine (`lightweight` only in v1; `chromium` is reserved and rejected at startup).

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDocumentStore } from '@/services/document/document-store.js';
import { formatEnvelopeLines } from '@/services/document/format-envelope.js';
import { DocumentEnvelopeSchema } from '@/services/document/types.js';

export const getDocumentTool = tool('docgen_get_document', {
  title: 'docgen-mcp-server', // display identity is the unscoped package name on every surface
  description:
    'Re-fetch a previously rendered document by the id a docgen render/export/fill tool returned.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    documentId: z
      .string()
      .min(1)
      .describe('The opaque id returned by an earlier docgen render/export/fill call.'),
  }),
  output: z.object({ document: DocumentEnvelopeSchema }),
  errors: [
    {
      reason: 'document_expired',
      code: JsonRpcErrorCode.NotFound,
      when: 'No stored document for that id — expired past its TTL, or never existed.',
      recovery:
        'Re-render with the originating docgen render/export/fill tool; ids are single-render and not reusable.',
    },
  ],

  async handler(input, ctx) {
    const store = getDocumentStore();
    const resolved = await store.get(input.documentId, ctx);
    // Handlers throw; ctx.fail is typed against the declared reasons, recoveryFor mirrors the hint into content[].
    if (!resolved) {
      throw ctx.fail('document_expired', `No document found for id ${input.documentId}.`, {
        ...ctx.recoveryFor('document_expired'),
      });
    }
    return { document: store.buildEnvelope(resolved.meta, resolved.bytes, ctx) };
  },

  // format() is the markdown twin of structuredContent — both surfaces carry the same envelope.
  format: (result) => {
    const d = result.document;
    return [
      { type: 'text', text: formatEnvelopeLines(`Retrieved ${(d.byteSize / 1024).toFixed(1)} KB.`, d) },
    ];
  },
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDocumentStore } from '@/services/document/document-store.js';

export const documentResource = resource('docgen://document/{documentId}', {
  name: 'docgen-document',
  title: 'docgen-mcp-server',
  description: 'Fetch a rendered document by id — raw bytes as a blob plus a JSON metadata block.',
  mimeType: 'application/octet-stream', // per-item mime types are set on the returned content
  params: z.object({
    documentId: z
      .string()
      .min(1)
      .describe('The opaque id returned by a docgen render/export/fill tool.'),
  }),
  errors: [
    {
      reason: 'document_expired',
      code: JsonRpcErrorCode.NotFound,
      when: 'No stored document for that id — expired past its TTL, or never existed.',
      recovery:
        'Re-render with the originating docgen render/export/fill tool; ids are single-render and not reusable.',
    },
  ],
  async handler(params, ctx) {
    const resolved = await getDocumentStore().get(params.documentId, ctx);
    if (!resolved) {
      throw ctx.fail('document_expired', `No document found for id ${params.documentId}.`, {
        ...ctx.recoveryFor('document_expired'),
      });
    }
    return resolved;
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  documentTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(900)
    .describe('How long a rendered document is retrievable before it expires, in seconds.'),
  maxDocumentBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(26_214_400)
    .describe('Hard ceiling on a single rendered artifact in bytes; exceeding it aborts the render.'),
  renderTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-render wall-clock budget in milliseconds; exceeding it aborts the render.'),
  inlineMaxBytes: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5_242_880)
    .describe('Artifacts at or under this byte size are returned inline as base64; larger ones omit it.'),
  pdfEngine: z
    .enum(['lightweight', 'chromium'])
    .default('lightweight')
    .describe('Selects the PDF rendering engine. Only `lightweight` is implemented in v1.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    documentTtlSeconds: 'DOCGEN_DOCUMENT_TTL_SECONDS',
    maxDocumentBytes: 'DOCGEN_MAX_DOCUMENT_BYTES',
    renderTimeoutMs: 'DOCGEN_RENDER_TIMEOUT_MS',
    inlineMaxBytes: 'DOCGEN_INLINE_MAX_BYTES',
    pdfEngine: 'DOCGEN_PDF_ENGINE',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`DOCGEN_DOCUMENT_TTL_SECONDS`) not the path (`documentTtlSeconds`). Throws `ConfigurationError`, which the framework prints as a clean startup banner — `chromium` is parsed but rejected here until the high-fidelity engine ships.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` uses the bare repository name for both identity fields. The package description and website remain canonical in `package.json` and are not duplicated here:

```ts
await createApp({
  name: 'docgen-mcp-server',
  title: 'docgen-mcp-server',
  instructions: 'Render structured content into downloadable PDF and xlsx documents.',
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, regional notes, scope hints) instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino and `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | Reader over a retried request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped`. Empty on the first round. |
| `ctx.enrich` | Success-path agent context — `.notice()`, `.total()`, `.echo()`, `.truncated()`, or a definition-specific object. Reaches `structuredContent` and `content[]` when the definition declares `enrichment`. |
| `ctx.content` | Non-text success content — `.image(data, mimeType)`, `.audio(data, mimeType)`, or a raw block. Prepended to `content[]`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.recoveryFor(reason)` | Typed lookup of the contract `recovery` for a declared reason. Returns `{ recovery: { hint } }` for known reasons, `{}` otherwise. Spread into `ctx.fail` data to mirror the contract hint into `content[]`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) and is the single source of truth for the agent's next move. Pass `ctx.recoveryFor('reason')` as the throw data to expose the hint on both public error surfaces. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`, ctx.recoveryFor('no_match'));
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point — wires services, registers the surface
  config/
    server-config.ts                    # DOCGEN_* env vars (Zod schema)
  services/
    document/
      render-service.ts                 # Bundled render stack (PDF, xlsx, form-fill); byte ceiling + timeout
      document-store.ts                 # Tenant-scoped, TTL-bounded artifact store; mints ids, builds the envelope
      fetch-guard.ts                    # SSRF-guarded PDF fetcher for the fill_form url source
      html-blocks.ts                    # HTML/markdown → linear block model for the lightweight engine
      format-envelope.ts                # Shared DocumentEnvelope formatter
      render-types.ts                   # Render-input Zod schemas
      types.ts                          # Domain types (DocumentEnvelope, StoredDocumentMeta)
  mcp-server/
    tools/definitions/
      render-pdf.tool.ts                # docgen_render_pdf
      export-spreadsheet.tool.ts        # docgen_export_spreadsheet
      fill-form.tool.ts                 # docgen_fill_form
      get-document.tool.ts              # docgen_get_document
    resources/definitions/
      document.resource.ts              # docgen://document/{documentId}
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run lint:mcp` | Run the MCP definition linter standalone |
| `bun run lint:packaging` | Run packaging-surface checks |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run all Vitest projects |
| `bun run test:coverage` | Run all Vitest projects with Istanbul coverage |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from per-version files |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings. MCPB is stdio-only — HTTP deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
