/**
 * @fileoverview docgen_fill_form tool — fills the AcroForm fields of a supplied PDF
 * (base64 or an https URL fetched behind an SSRF guard), optionally flattens it,
 * stores the result (tenant-scoped, TTL-bounded), and returns the shared
 * DocumentEnvelope plus the field names that had no match. For tax forms,
 * applications, and templates the human already has.
 * @module mcp-server/tools/definitions/fill-form.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDocumentStore } from '@/services/document/document-store.js';
import { formatEnvelopeLines } from '@/services/document/format-envelope.js';
import { getRenderService } from '@/services/document/render-service.js';
import { FormFieldsSchema, SourcePdfSchema } from '@/services/document/render-types.js';
import { DocumentEnvelopeSchema } from '@/services/document/types.js';

/** Decodes a base64 string to bytes, returning null when it is not valid base64. */
function decodeBase64Pdf(b64: string): Uint8Array | null {
  const cleaned = b64.replace(/^data:application\/pdf;base64,/, '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length === 0) return null;
  try {
    const bytes = new Uint8Array(Buffer.from(cleaned, 'base64'));
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export const fillFormTool = tool('docgen_fill_form', {
  title: 'docgen-mcp-server',
  description:
    'Fill the AcroForm fields of a supplied PDF and optionally flatten it. Provide the source PDF as exactly one of { base64 } or { url } (an https URL fetched behind an SSRF guard; base64 avoids any fetch), plus a fields map of AcroForm field name → value. Field names must match the PDF internal names exactly (case-sensitive); obtain them from whoever supplied the form, since docgen does not expose them. Names with no AcroForm counterpart come back in unmatchedFields[] rather than failing — correct them and re-render. Set flatten to bake the values in so the result is no longer editable. Returns a delivery envelope with a documentId, resource URI, pageCount, and inline base64 when small enough.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    sourcePdf: SourcePdfSchema,
    fields: FormFieldsSchema,
    flatten: z
      .boolean()
      .default(false)
      .describe(
        'When true, flatten the form after filling so values are baked in and no longer editable.',
      ),
  }),
  output: z.object({
    document: DocumentEnvelopeSchema,
    unmatchedFields: z
      .array(z.string())
      .describe(
        'Field names from the input map that had no matching AcroForm field. Empty when every field matched. Correct these and re-render to fill them.',
      ),
  }),
  errors: [
    {
      reason: 'not_a_form',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The source PDF has no AcroForm fields to fill (a flat or XFA-only PDF).',
      recovery:
        'Confirm the PDF is a fillable AcroForm; a flat or XFA-only PDF cannot be filled here.',
    },
    {
      reason: 'invalid_pdf_source',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'sourcePdf.base64 was provided but is not a valid base64-encoded PDF.',
      recovery:
        'Re-encode the PDF as base64 and verify the content starts with JVBERi (the base64 prefix for %PDF-).',
    },
    {
      reason: 'source_unfetchable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'sourcePdf.url did not return a fetchable PDF — non-2xx, wrong content-type, too large, or blocked by the SSRF guard.',
      recovery:
        'Verify the URL is public https serving application/pdf, or pass the PDF as base64 to skip the fetch entirely.',
    },
    {
      reason: 'invalid_source',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither base64 nor url was provided for sourcePdf, or both were.',
      recovery: 'Provide exactly one source: { base64 } or { url }.',
    },
    {
      reason: 'document_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The filled PDF exceeded the configured maximum document size.',
      recovery: 'Use a smaller source PDF and render again.',
    },
    {
      reason: 'render_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Filling exceeded the configured time budget.',
      recovery: 'Use a smaller or simpler source PDF, then retry.',
    },
  ],

  async handler(input, ctx) {
    const { sourcePdf } = input;
    const hasBase64 = sourcePdf.base64 !== undefined && sourcePdf.base64 !== '';
    const hasUrl = sourcePdf.url !== undefined && sourcePdf.url !== '';
    if (hasBase64 === hasUrl) {
      throw ctx.fail('invalid_source', 'Provide exactly one PDF source: base64 or url.', {
        ...ctx.recoveryFor('invalid_source'),
      });
    }

    const render = getRenderService();
    let sourceBytes: Uint8Array;
    if (hasBase64) {
      const decoded = decodeBase64Pdf(sourcePdf.base64!);
      if (!decoded) {
        throw ctx.fail('invalid_pdf_source', undefined, {
          ...ctx.recoveryFor('invalid_pdf_source'),
        });
      }
      sourceBytes = decoded;
    } else {
      // SSRF guard + size cap live inside fetchSourcePdf; it throws source_unfetchable.
      sourceBytes = await render.fetchSourcePdf(sourcePdf.url!, ctx);
    }

    const result = await render.fillForm(sourceBytes, input.fields, input.flatten, ctx);
    const document = await getDocumentStore().put(result, ctx);
    if (result.unmatchedFields.length > 0) {
      ctx.log.notice('Form fill had unmatched field names', { unmatched: result.unmatchedFields });
    }
    return { document, unmatchedFields: result.unmatchedFields };
  },

  format: (result) => {
    const d = result.document;
    const kb = (d.byteSize / 1024).toFixed(1);
    const pages = d.pageCount ?? 0;
    const envelope = formatEnvelopeLines(`Filled a ${pages}-page PDF form (${kb} KB).`, d);
    const unmatched =
      result.unmatchedFields.length > 0
        ? `**Unmatched fields:** ${result.unmatchedFields.join(', ')} — correct these names and re-render to fill them.`
        : '**Unmatched fields:** none — every field name matched.';
    return [{ type: 'text', text: `${envelope}\n${unmatched}` }];
  },
});
