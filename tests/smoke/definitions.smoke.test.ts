/**
 * @fileoverview Smoke coverage for every MCP definition shipped by docgen-mcp-server.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it } from 'vitest';
import { documentResource } from '@/mcp-server/resources/definitions/document.resource.js';
import { exportSpreadsheetTool } from '@/mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { fillFormTool } from '@/mcp-server/tools/definitions/fill-form.tool.js';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

const allErrors = [
  ...(renderPdfTool.errors ?? []),
  ...(exportSpreadsheetTool.errors ?? []),
  ...(fillFormTool.errors ?? []),
  ...(getDocumentTool.errors ?? []),
  ...(documentResource.errors ?? []),
] as const;

beforeEach(() => {
  initRenderService();
  initDocumentStore();
});

describe('definition smoke test', () => {
  it('executes all four tools and the document resource', async () => {
    const ctx = createMockContext({ tenantId: 'smoke', errors: allErrors });

    const rendered = await renderPdfTool.handler(
      renderPdfTool.input.parse({ source: { markdown: '# Smoke' } }),
      ctx,
    );
    const workbook = await exportSpreadsheetTool.handler(
      exportSpreadsheetTool.input.parse({
        sheets: [{ name: 'Smoke', rows: [{ status: 'ok' }] }],
      }),
      ctx,
    );

    const source = await PDFDocument.create();
    const page = source.addPage([300, 200]);
    source.getForm().createTextField('status').addToPage(page, {
      x: 20,
      y: 150,
      width: 200,
      height: 20,
    });
    const filled = await fillFormTool.handler(
      fillFormTool.input.parse({
        sourcePdf: { base64: Buffer.from(await source.save()).toString('base64') },
        fields: { status: 'ok' },
      }),
      ctx,
    );

    const fetched = await getDocumentTool.handler(
      getDocumentTool.input.parse({ documentId: rendered.document.documentId }),
      ctx,
    );
    const uri = new URL(`docgen://document/${workbook.document.documentId}`);
    const resourceCtx = Object.assign(ctx, { uri });
    const resourceData = await documentResource.handler(
      { documentId: workbook.document.documentId },
      resourceCtx,
    );
    const contents = documentResource.format!(resourceData, {
      uri,
      mimeType: 'application/octet-stream',
    });

    expect(rendered.document.mimeType).toBe('application/pdf');
    expect(workbook.document.sheetCount).toBe(1);
    expect(filled.unmatchedFields).toEqual([]);
    expect(fetched.document.documentId).toBe(rendered.document.documentId);
    expect(contents).toHaveLength(2);
  });
});
