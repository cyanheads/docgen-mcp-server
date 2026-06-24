/**
 * @fileoverview Server-specific environment configuration for docgen-mcp-server.
 * Defines the `DOCGEN_*` env vars (document TTL, byte ceiling, render timeout,
 * inline threshold, PDF engine) as a lazy-parsed Zod schema, kept separate from
 * the framework's core config.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * The PDF rendering engine. `lightweight` (the pdf-lib programmatic path) is the
 * only engine implemented in v1; `chromium` reserves the seam for the deferred
 * high-fidelity headless path and is rejected at startup until implemented.
 */
export const PDF_ENGINES = ['lightweight', 'chromium'] as const;

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
    .describe(
      'Hard ceiling on a single rendered artifact in bytes; exceeding it aborts the render.',
    ),
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
    .describe(
      'Artifacts at or under this byte size are returned inline as base64; larger ones omit it.',
    ),
  pdfEngine: z
    .enum(PDF_ENGINES)
    .default('lightweight')
    .describe('Selects the PDF rendering engine. Only `lightweight` is implemented in v1.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parses and returns the server-specific configuration. Throws a
 * `ConfigurationError` (rendered as a clean startup banner) when a `DOCGEN_*`
 * env var is malformed, or when an unimplemented PDF engine is selected.
 */
export function getServerConfig(): ServerConfig {
  if (_config) return _config;

  const parsed = parseEnvConfig(ServerConfigSchema, {
    documentTtlSeconds: 'DOCGEN_DOCUMENT_TTL_SECONDS',
    maxDocumentBytes: 'DOCGEN_MAX_DOCUMENT_BYTES',
    renderTimeoutMs: 'DOCGEN_RENDER_TIMEOUT_MS',
    inlineMaxBytes: 'DOCGEN_INLINE_MAX_BYTES',
    pdfEngine: 'DOCGEN_PDF_ENGINE',
  });

  if (parsed.pdfEngine === 'chromium') {
    throw new Error(
      'DOCGEN_PDF_ENGINE=chromium is not implemented in this version. Use the default `lightweight` engine.',
    );
  }

  _config = parsed;
  return _config;
}

/** Test-only reset of the memoized config. */
export function resetServerConfig(): void {
  _config = undefined;
}
