/**
 * @fileoverview Read-only AcroForm field discovery before filling a PDF.
 * @module mcp-server/tools/definitions/list-form-fields.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRenderService } from '@/services/document/render-service.js';
import { SourcePdfSchema } from '@/services/document/render-types.js';
import { resolveSourcePdf } from '@/services/document/source-pdf.js';

/** Discovers exact field names, types, required flags and choice options. */
export const listFormFieldsTool = tool('docgen_list_form_fields', {
  title: 'List PDF Form Fields',
  description:
    'List the AcroForm fields in a PDF before calling docgen_fill_form. Provide exactly one sourcePdf.base64 or sourcePdf.url; URL sources must be public https serving application/pdf. Returns exact case-sensitive names (including nested names), canonical field types, required flags and options on dropdown, optionList and radioGroup fields. Signature and button entries are discovery only; docgen_fill_form does not sign PDFs or invoke buttons. Does not change the PDF or store a document.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({ sourcePdf: SourcePdfSchema }),
  output: z.object({
    fields: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe('Exact case-sensitive AcroForm field name, including any parent path.'),
            type: z
              .enum([
                'text',
                'checkbox',
                'dropdown',
                'optionList',
                'radioGroup',
                'signature',
                'button',
              ])
              .describe('Canonical field type; signatures and buttons are discovery only.'),
            required: z.boolean().describe('Whether the PDF marks this field as required.'),
            options: z
              .array(z.string())
              .optional()
              .describe(
                'Available choices, present only for dropdown, optionList and radioGroup fields.',
              ),
          })
          .describe('One AcroForm field inventory entry.'),
      )
      .describe('Every supported AcroForm field; a PDF without fields returns not_a_form.'),
  }),
  errors: [
    {
      reason: 'invalid_source',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither base64 nor url was provided for sourcePdf, or both were.',
      recovery: 'Provide exactly one source: { base64 } or { url }.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_pdf_source',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The source is not a valid base64-encoded PDF or valid PDF bytes.',
      recovery:
        'Re-encode the PDF as base64 and verify the content starts with JVBERi (the base64 prefix for %PDF-).',
      thrownBy: 'service',
    },
    {
      reason: 'not_a_form',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The source PDF has no AcroForm fields (a flat or XFA-only PDF).',
      recovery:
        'Confirm the PDF is a fillable AcroForm; a flat or XFA-only PDF cannot be filled here.',
      thrownBy: 'service',
    },
    {
      reason: 'source_unfetchable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The URL is blocked or did not return a fetchable PDF.',
      recovery:
        'Verify the URL is public https serving application/pdf, or pass the PDF as base64 to skip the fetch entirely.',
      thrownBy: 'service',
    },
    {
      reason: 'render_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Inspection exceeded the configured time budget.',
      recovery: 'Use a smaller or simpler source PDF, then retry.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const bytes = await resolveSourcePdf(input.sourcePdf, ctx);
    return { fields: await getRenderService().listFormFields(bytes, ctx) };
  },
  format: (result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
});
