/**
 * @fileoverview docgen_get_document tool — re-fetches a previously rendered
 * document by the id a render/export/fill tool minted, returning the same
 * DocumentEnvelope. A pure read against the tenant-scoped DocumentStore; the
 * canonical cross-tool dependency (its id input comes only from another tool's
 * output).
 * @module mcp-server/tools/definitions/get-document.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DOCUMENT_ID_PATTERN, getDocumentStore } from '@/services/document/document-store.js';
import { formatEnvelopeLines } from '@/services/document/format-envelope.js';
import { DocumentEnvelopeSchema } from '@/services/document/types.js';

export const getDocumentTool = tool('docgen_get_document', {
  title: 'docgen-mcp-server',
  description:
    'Re-fetch a previously rendered document by the id a docgen render/export/fill tool returned. Returns the same delivery envelope (metadata plus resource URI, and inline base64 when small enough). Use it to recover a document whose inline copy was dropped (over the inline size limit) while it is still within its TTL. The documentId is obtainable ONLY from an earlier docgen_render_pdf, docgen_export_spreadsheet, or docgen_fill_form result — it is not guessable, and an expired or unknown id returns document_expired.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    documentId: z
      .string()
      .regex(
        DOCUMENT_ID_PATTERN,
        'documentId must be an id returned by a docgen render/export/fill tool — `doc_` followed by 24 url-safe characters.',
      )
      .describe(
        'The opaque document id returned by an earlier docgen_render_pdf, docgen_export_spreadsheet, or docgen_fill_form call. Format `doc_` followed by 24 url-safe characters.',
      ),
  }),
  output: z.object({
    document: DocumentEnvelopeSchema,
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

  async handler(input, ctx) {
    const store = getDocumentStore();
    const resolved = await store.get(input.documentId, ctx);
    if (!resolved) {
      throw ctx.fail('document_expired', `No document found for id ${input.documentId}.`, {
        ...ctx.recoveryFor('document_expired'),
      });
    }
    const document = store.buildEnvelope(resolved.meta, resolved.bytes, ctx);
    return { document };
  },

  format: (result) => {
    const d = result.document;
    const kind = d.mimeType === 'application/pdf' ? 'PDF' : 'spreadsheet';
    const kb = (d.byteSize / 1024).toFixed(1);
    return [{ type: 'text', text: formatEnvelopeLines(`Retrieved ${kind} — ${kb} KB.`, d) }];
  },
});
