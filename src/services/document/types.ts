/**
 * @fileoverview Shared document-generation domain types and Zod schemas.
 * Defines the `DocumentMime` enum, the `DocumentEnvelope` delivery shape returned
 * by every render/export/fill tool and `docgen_get_document`, the internal stored
 * metadata record, and the render-result shape produced by `RenderService`.
 * @module services/document/types
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The two output document mime types docgen produces in v1. */
export const PDF_MIME = 'application/pdf' as const;
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

/**
 * Mime-type enum constraining envelope output to exactly the formats docgen
 * emits — never a bare `string`, so the surface documents which formats exist.
 */
export const DocumentMimeSchema = z
  .enum([PDF_MIME, XLSX_MIME])
  .describe('Mime type of the rendered artifact — PDF or xlsx.');

export type DocumentMime = z.infer<typeof DocumentMimeSchema>;

/**
 * The shared delivery shape returned by every render/export/fill tool and by
 * `docgen_get_document`. Bytes ride as a stable resource URI and/or inline base64;
 * metadata is always present on both client surfaces.
 *
 * Required-field discipline: `pageCount`, `sheetCount`, `downloadUrl`, and
 * `inlineBase64` are `.optional()` because they are populated only on some code
 * paths (PDF vs xlsx, hosted vs stdio, small vs large). Every other field is
 * populated on every return path.
 */
export const DocumentEnvelopeSchema = z
  .object({
    documentId: z
      .string()
      .describe(
        'Opaque id minted by the render/export/fill tool — the chaining key for docgen_get_document and the docgen://document/{id} resource. Format `doc_` + 24 url-safe chars. Obtainable ONLY from a render/export/fill tool output; not guessable or constructible.',
      ),
    resourceUri: z
      .string()
      .describe('Stable read URI `docgen://document/{documentId}` resolving to the document.'),
    downloadUrl: z
      .string()
      .optional()
      .describe(
        'Absolute https URL to the bytes; present only in HTTP/hosted mode (derived from the public origin). Omitted in stdio.',
      ),
    mimeType: DocumentMimeSchema,
    byteSize: z.number().int().nonnegative().describe('Size of the rendered artifact in bytes.'),
    pageCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of pages — present for PDF documents (render_pdf, fill_form) only.'),
    sheetCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of worksheets — present for xlsx documents (export_spreadsheet) only.'),
    ttlSecondsRemaining: z
      .number()
      .int()
      .nonnegative()
      .describe('Seconds until the stored artifact expires and becomes unreadable.'),
    createdAt: z.string().describe('ISO 8601 UTC timestamp when the document was rendered.'),
    inlineBase64: z
      .string()
      .optional()
      .describe(
        'The document bytes, base64-encoded. Present when the artifact is at or under the inline threshold; omitted (field absent) when larger — fetch via the resource or download URL instead.',
      ),
  })
  .describe(
    'Delivery envelope for a rendered document — metadata plus resource/inline byte access.',
  );

export type DocumentEnvelope = z.infer<typeof DocumentEnvelopeSchema>;

/**
 * Internal tenant-scoped metadata record persisted between a render/export/fill
 * call and a later docgen_get_document / resource read. Stored under
 * `doc:meta:{documentId}`; the bytes are stored separately under
 * `doc:blob:{documentId}` with the same TTL so the pair expires atomically.
 */
export interface StoredDocumentMeta {
  blobKey: string;
  byteSize: number;
  createdAt: string;
  documentId: string;
  /** Absolute expiry as epoch millis — used to compute ttlSecondsRemaining on read. */
  expiresAtMs: number;
  mimeType: DocumentMime;
  pageCount?: number;
  sheetCount?: number;
}

/**
 * The result of a single render operation, before storage. `RenderService`
 * returns this; `DocumentStore.put` persists it and builds the envelope.
 */
export interface RenderResult {
  bytes: Uint8Array;
  mimeType: DocumentMime;
  pageCount?: number;
  sheetCount?: number;
}
