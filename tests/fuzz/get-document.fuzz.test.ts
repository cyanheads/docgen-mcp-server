/**
 * @fileoverview Property-based fuzz coverage for the document lookup contract.
 * @module tests/fuzz/get-document.fuzz.test
 */

import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import { expect, it } from 'vitest';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';

it('keeps document lookup safe across generated and adversarial inputs', async () => {
  initDocumentStore();
  const report = await fuzzTool(getDocumentTool, {
    ctx: { tenantId: 'fuzz' },
    numRuns: 50,
    numAdversarial: 30,
    seed: 20_260_821,
  });

  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
