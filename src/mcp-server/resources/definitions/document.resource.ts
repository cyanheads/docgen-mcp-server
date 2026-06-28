/**
 * @fileoverview docgen://document/{documentId} resource — the stable-URI delivery
 * surface for a rendered document. Resolves the id to two content items: a blob
 * carrying the raw bytes (base64) with the document's real mime type, and a JSON
 * metadata block. Reads the same tenant-scoped DocumentStore as docgen_get_document
 * and never re-renders.
 * @module mcp-server/resources/definitions/document.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DOCUMENT_ID_PATTERN, getDocumentStore } from '@/services/document/document-store.js';
import type { StoredDocumentMeta } from '@/services/document/types.js';

/** Internal handler return — carries the bytes and meta to the formatter. */
interface DocumentResourceData {
  bytesBase64: string;
  meta: StoredDocumentMeta;
  ttlSecondsRemaining: number;
}

export const documentResource = resource('docgen://document/{documentId}', {
  name: 'docgen-document',
  title: 'docgen-mcp-server',
  description:
    'Fetch a rendered document by id. Returns the raw bytes as a blob (with the document mime type) plus a JSON metadata block. The id comes from a docgen render/export/fill tool result; readable until the document TTL expires, then document_expired.',
  // Per-item mime types are set on the returned content; this is the registration default.
  mimeType: 'application/octet-stream',
  params: z.object({
    documentId: z
      .string()
      .regex(
        DOCUMENT_ID_PATTERN,
        'documentId must be an id returned by a docgen render/export/fill tool — `doc_` followed by 24 url-safe characters.',
      )
      .describe('The opaque document id returned by a docgen render/export/fill tool.'),
  }),
  errors: [
    {
      reason: 'document_expired',
      code: JsonRpcErrorCode.NotFound,
      when: 'No stored document for that id — expired past its TTL, or never existed.',
      recovery:
        'Re-render the document with the originating docgen render/export/fill tool; ids are single-render and not reusable.',
    },
  ],

  async handler(params, ctx): Promise<DocumentResourceData> {
    const store = getDocumentStore();
    const resolved = await store.get(params.documentId, ctx);
    if (!resolved) {
      throw ctx.fail('document_expired', `No document found for id ${params.documentId}.`, {
        ...ctx.recoveryFor('document_expired'),
      });
    }
    const ttlSecondsRemaining = Math.max(
      0,
      Math.round((resolved.meta.expiresAtMs - Date.now()) / 1000),
    );
    return {
      meta: resolved.meta,
      bytesBase64: Buffer.from(resolved.bytes).toString('base64'),
      ttlSecondsRemaining,
    };
  },

  format: (result, meta) => {
    const data = result as DocumentResourceData;
    const m = data.meta;
    const metadata = {
      documentId: m.documentId,
      byteSize: m.byteSize,
      ...(m.pageCount !== undefined && { pageCount: m.pageCount }),
      ...(m.sheetCount !== undefined && { sheetCount: m.sheetCount }),
      createdAt: m.createdAt,
      ttlSecondsRemaining: data.ttlSecondsRemaining,
    };
    return [
      { uri: meta.uri.href, blob: data.bytesBase64, mimeType: m.mimeType },
      { uri: meta.uri.href, text: JSON.stringify(metadata, null, 2), mimeType: 'application/json' },
    ];
  },
});
