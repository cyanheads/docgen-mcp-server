/**
 * @fileoverview docgen_export_spreadsheet tool — renders one or more named sheets
 * of row objects to an .xlsx workbook, stores it (tenant-scoped, TTL-bounded), and
 * returns the shared DocumentEnvelope. The export stage for tabular data an agent
 * holds (often rows from another server's tool output).
 * @module mcp-server/tools/definitions/export-spreadsheet.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDocumentStore } from '@/services/document/document-store.js';
import { formatEnvelopeLines } from '@/services/document/format-envelope.js';
import { getRenderService } from '@/services/document/render-service.js';
import { SheetSchema } from '@/services/document/render-types.js';
import { DocumentEnvelopeSchema } from '@/services/document/types.js';

export const exportSpreadsheetTool = tool('docgen_export_spreadsheet', {
  title: 'docgen-mcp-server',
  description:
    'Render one or more named worksheets of row objects to a downloadable .xlsx workbook. Each sheet is a name plus an array of row objects (property → scalar), with an optional column spec controlling header label, value type, width, and number/date format. An empty rows array yields a header-only sheet; provide at least one sheet. Returns a delivery envelope with a documentId, resource URI, sheetCount, byte size, and inline base64 when small enough. The natural export stage for tabular data pulled from another server — reshape its rows into sheets[] and render.',
  annotations: { readOnlyHint: false, openWorldHint: false },
  input: z.object({
    sheets: z
      .array(SheetSchema)
      .describe('One or more named worksheets to render into the workbook.'),
  }),
  output: z.object({
    document: DocumentEnvelopeSchema,
  }),
  enrichment: {
    engine: z.string().describe('The rendering engine that produced the workbook.'),
  },
  errors: [
    {
      reason: 'empty_workbook',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The sheets array was empty — no worksheets to render.',
      recovery: 'Provide at least one sheet with a name and a rows array (rows may be empty).',
    },
    {
      reason: 'invalid_sheet_name',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A worksheet name is blank, over 31 characters, contains * ? : \\ / [ ], begins or ends with an apostrophe, or duplicates another sheet name (case-insensitive).',
      recovery:
        'Rename the sheet to a unique 1–31 character label without * ? : \\ / [ ] and with no leading or trailing apostrophe.',
      thrownBy: 'service',
    },
    {
      reason: 'document_too_large',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The rendered workbook exceeded the configured maximum document size.',
      recovery:
        'Reduce the number of rows or sheets and render again, or split into multiple workbooks.',
      thrownBy: 'service',
    },
    {
      reason: 'render_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Rendering exceeded the configured time budget.',
      recovery: 'Reduce the workbook size or split it into smaller renders, then retry.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (input.sheets.length === 0) {
      throw ctx.fail('empty_workbook', undefined, { ...ctx.recoveryFor('empty_workbook') });
    }
    const result = await getRenderService().renderSpreadsheet(input.sheets, ctx);
    const document = await getDocumentStore().put(result, ctx);
    ctx.enrich({ engine: 'exceljs' });
    return { document };
  },

  format: (result) => {
    const d = result.document;
    const kb = (d.byteSize / 1024).toFixed(1);
    const sheets = d.sheetCount ?? 0;
    return [
      {
        type: 'text',
        text: formatEnvelopeLines(`Exported a ${sheets}-sheet workbook (${kb} KB).`, d),
      },
    ];
  },
});
