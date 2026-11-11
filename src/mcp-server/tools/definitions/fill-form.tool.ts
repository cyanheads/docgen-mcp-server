/**
 * @fileoverview docgen_fill_form tool — fills the AcroForm fields of a supplied PDF
 * (base64 or an https URL fetched behind an SSRF guard), optionally flattens it,
 * stores the result (tenant-scoped, TTL-bounded), and returns the shared
 * DocumentEnvelope plus the assignment report.
 * @module mcp-server/tools/definitions/fill-form.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDocumentStore } from '@/services/document/document-store.js';
import { formatEnvelopeLines } from '@/services/document/format-envelope.js';
import { getRenderService } from '@/services/document/render-service.js';
import { FormFieldsSchema, SourcePdfSchema } from '@/services/document/render-types.js';
import { resolveSourcePdf } from '@/services/document/source-pdf.js';
import { DocumentEnvelopeSchema } from '@/services/document/types.js';

export const fillFormTool = tool('docgen_fill_form', {
  title: 'Fill PDF Form',
  description:
    'Fill the AcroForm fields of a supplied PDF and optionally flatten it. Provide exactly one of { base64 } or { url } (public HTTPS serving application/pdf, or application/octet-stream when bytes start with %PDF-), plus a fields map of AcroForm field name → value. Use docgen_list_form_fields for exact names, choices and constraints. Signatures and buttons are discovery only. Exact names win over unique aliases, which are reported in resolvedFields[]. Correct any names in unmatchedFields[] and re-render. A custom dropdown value can make a fixed dropdown editable, reported in madeEditableFields[]. Set flatten to bake the values in so the result is no longer editable. Returns a delivery envelope with a documentId, resource URI, pageCount, and inline base64 when small enough.',
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
        'Unknown, ambiguous or conflicting keys from the input map, in input order. Correct these and re-render to fill them.',
      ),
    resolvedFields: z
      .array(
        z
          .object({
            requested: z.string().describe('Alias as supplied in the input map.'),
            resolved: z.string().describe('Exact AcroForm name filled by the alias.'),
          })
          .describe('One accepted field-name alias.'),
      )
      .describe('Accepted field-name aliases in input order. Empty when no alias was used.'),
    madeEditableFields: z
      .array(z.string())
      .describe(
        'Exact names of fixed dropdowns made editable for custom values, before optional flattening.',
      ),
  }),
  enrichment: {
    notices: z
      .array(z.string())
      .describe('Warnings for unrecognized checkbox values and dropdowns made editable.'),
  },
  enrichmentTrailer: {
    notices: {
      render: (notices) => `**Notices**\n\n\`\`\`json\n${JSON.stringify(notices, null, 2)}\n\`\`\``,
    },
  },
  errors: [
    {
      reason: 'invalid_field_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One or more matched assignments violate field constraints or target discovery-only fields.',
      recovery:
        'Use docgen_list_form_fields to check field types, maximum lengths and allowed choices, then correct the listed values.',
      thrownBy: 'service',
    },
    {
      reason: 'not_a_form',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The source PDF has no AcroForm fields to fill (a flat or XFA-only PDF).',
      recovery:
        'Confirm the PDF is a fillable AcroForm; a flat or XFA-only PDF cannot be filled here.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_pdf_source',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sourcePdf.base64 was provided but is not a valid base64-encoded PDF.',
      recovery:
        'Re-encode the PDF as base64 and verify the content starts with JVBERi (the base64 prefix for %PDF-).',
    },
    {
      reason: 'source_unfetchable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'sourcePdf.url did not return a fetchable PDF — non-2xx, wrong content-type, too large, or blocked by the SSRF guard.',
      recovery:
        'Use a public HTTPS URL serving application/pdf or application/octet-stream with bytes starting with %PDF-, or pass the PDF as base64.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_source',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither base64 nor url was provided for sourcePdf, or both were.',
      recovery: 'Provide exactly one source: { base64 } or { url }.',
      thrownBy: 'service',
    },
    {
      reason: 'document_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The filled PDF exceeded the configured maximum document size.',
      recovery: 'Use a smaller source PDF and render again.',
      thrownBy: 'service',
    },
    {
      reason: 'render_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Filling exceeded the configured time budget.',
      recovery: 'Use a smaller or simpler source PDF, then retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const render = getRenderService();
    const sourceBytes = await resolveSourcePdf(input.sourcePdf, ctx);
    const result = await render.fillForm(sourceBytes, input.fields, input.flatten, ctx);
    const document = await getDocumentStore().put(result, ctx);
    if (result.unmatchedFields.length > 0) {
      ctx.log.notice('Form fill had unmatched field names', { unmatched: result.unmatchedFields });
    }
    ctx.enrich({ notices: result.notices });
    return {
      document,
      unmatchedFields: result.unmatchedFields,
      resolvedFields: result.resolvedFields,
      madeEditableFields: result.madeEditableFields,
    };
  },

  format: (result) => {
    const d = result.document;
    const kb = (d.byteSize / 1024).toFixed(1);
    const pages = d.pageCount ?? 0;
    const envelope = formatEnvelopeLines(`Filled a ${pages}-page PDF form (${kb} KB).`, d);
    const report = {
      unmatchedFields: result.unmatchedFields,
      resolvedFields: result.resolvedFields,
      madeEditableFields: result.madeEditableFields,
    };
    return [
      { type: 'text', text: envelope },
      { type: 'text', text: `\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`` },
    ];
  },
});
