/**
 * @fileoverview docgen_render_pdf tool — renders HTML, markdown, or a template+data
 * object to a PDF, stores it (tenant-scoped, TTL-bounded), and returns the shared
 * DocumentEnvelope. The flagship: the agent writes styled markup, the server prints
 * the file a human downloads.
 * @module mcp-server/tools/definitions/render-pdf.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDocumentStore } from '@/services/document/document-store.js';
import { formatEnvelopeLines } from '@/services/document/format-envelope.js';
import { getRenderService } from '@/services/document/render-service.js';
import { PageOptionsSchema, PdfSourceSchema } from '@/services/document/render-types.js';
import { DocumentEnvelopeSchema } from '@/services/document/types.js';

export const renderPdfTool = tool('docgen_render_pdf', {
  title: 'docgen-mcp-server',
  description:
    'Render content to a downloadable PDF document. Provide exactly one source: { html } (raw HTML you compose — the recommended path), { markdown } (converted to HTML then rendered), or { template, data } (a {{key}} template filled from a data object, server-owned layout). Control page size, orientation, margins, header/footer, and page numbers via pageOptions. Returns a delivery envelope with a documentId, resource URI, pageCount, byte size, and inline base64 when small enough. The lightweight engine renders structured layout (headings, paragraphs, lists, tables) but not arbitrary CSS — a degraded flag is set when unsupported styling is dropped.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    source: PdfSourceSchema,
    pageOptions: PageOptionsSchema.optional().describe(
      'Page layout options; sensible defaults apply.',
    ),
  }),
  output: z.object({
    document: DocumentEnvelopeSchema,
  }),
  enrichment: {
    engine: z.string().describe('The PDF rendering engine that produced the document.'),
    degraded: z
      .boolean()
      .describe(
        'True when the lightweight engine dropped unsupported styling (CSS, images, scripts).',
      ),
  },
  errors: [
    {
      reason: 'invalid_source',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'None of html / markdown / template+data was provided, more than one source form was, a template was given without data, or data was given without a template.',
      recovery:
        'Provide exactly one source: { html }, { markdown }, or { template, data } — not zero and not several. data pairs only with template.',
    },
    {
      reason: 'template_render_failed',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The template referenced a data key absent from the data object, or was malformed.',
      recovery:
        "Check the template's {{referenced}} fields against the keys present in the data object.",
    },
    {
      reason: 'document_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The rendered PDF exceeded the configured maximum document size.',
      recovery: 'Reduce the content (fewer pages, smaller images) and render again.',
    },
    {
      reason: 'render_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Rendering exceeded the configured time budget.',
      recovery: 'Simplify the document or split it into smaller renders, then retry.',
    },
  ],

  async handler(input, ctx) {
    const { source } = input;
    const present = [
      source.html !== undefined,
      source.markdown !== undefined,
      source.template !== undefined,
    ].filter(Boolean).length;
    if (present !== 1) {
      throw ctx.fail(
        'invalid_source',
        present === 0
          ? 'No source provided. Supply exactly one of html, markdown, or template+data.'
          : 'Multiple sources provided. Supply exactly one of html, markdown, or template+data.',
        { ...ctx.recoveryFor('invalid_source') },
      );
    }
    if (source.template !== undefined && source.data === undefined) {
      throw ctx.fail('invalid_source', 'The template source requires a data object.', {
        ...ctx.recoveryFor('invalid_source'),
      });
    }
    if (source.data !== undefined && source.template === undefined) {
      throw ctx.fail(
        'invalid_source',
        'The data object is only used with a template source; html and markdown ignore it. Provide { template, data }, or remove data.',
        { ...ctx.recoveryFor('invalid_source') },
      );
    }

    const pageOptions = PageOptionsSchema.parse(input.pageOptions ?? {});
    const result = await getRenderService().renderPdf(source, pageOptions, ctx);
    const document = await getDocumentStore().put(result, ctx);
    ctx.enrich({ engine: 'lightweight', degraded: result.degraded });
    return { document };
  },

  format: (result) => {
    const d = result.document;
    const kb = (d.byteSize / 1024).toFixed(1);
    const pages = d.pageCount ?? 0;
    return [
      { type: 'text', text: formatEnvelopeLines(`Rendered a ${pages}-page PDF (${kb} KB).`, d) },
    ];
  },
});
