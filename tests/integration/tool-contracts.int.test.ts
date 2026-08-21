/**
 * @fileoverview Production-shaped SDK v2 contract coverage for docgen tools.
 * @module tests/integration/tool-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { beforeEach } from 'vitest';
import { exportSpreadsheetTool } from '@/mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

beforeEach(() => {
  initRenderService();
  initDocumentStore();
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
