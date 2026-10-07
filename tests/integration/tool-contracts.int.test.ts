/**
 * @fileoverview Production-shaped SDK v2 contract coverage for docgen tools.
 * @module tests/integration/tool-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach, expect, it } from 'vitest';
import { exportSpreadsheetTool } from '@/mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

beforeEach(() => {
  initRenderService();
  initDocumentStore();
});

it('preserves declared recovery on both tool error surfaces', async () => {
  const sheets: Parameters<typeof exportSpreadsheetTool.handler>[0]['sheets'] = [];
  for (const [definition, input, reason] of [
    [exportSpreadsheetTool, { sheets }, 'empty_workbook'],
    [renderPdfTool, { source: {} }, 'invalid_source'],
    [getDocumentTool, { documentId: 'doc_AAAAAAAAAAAAAAAAAAAAAAAA' }, 'document_expired'],
  ] as const) {
    const result = await runToolContract(definition, input, {
      context: { tenantId: 'integration' },
    });
    const recovery = definition.errors?.find((entry) => entry.reason === reason)?.recovery;
    expect(recovery).toBeDefined();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason, recovery: { hint: recovery } } } },
    });
    expect(JSON.stringify(result.content)).toContain(recovery);
  }
});

toolContractSuite(exportSpreadsheetTool, {
  context: { tenantId: 'integration' },
  success: [
    {
      name: 'validates, invokes, and formats an xlsx export',
      input: { sheets: [{ name: 'Data', rows: [{ value: 1 }] }] },
    },
  ],
  errors: [
    {
      name: 'returns the declared dual-surface error envelope',
      input: { sheets: [] },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'empty_workbook',
    },
  ],
});
