/**
 * @fileoverview Production-shaped SDK v2 contract coverage for docgen tools.
 * @module tests/integration/tool-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { exportSpreadsheetTool } from '@/mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { fillFormTool } from '@/mcp-server/tools/definitions/fill-form.tool.js';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { listFormFieldsTool } from '@/mcp-server/tools/definitions/list-form-fields.tool.js';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

it('distinguishes domain validation from malformed arguments on both surfaces', async () => {
  for (const [input, code, reason] of [
    [{ sheets: [] }, JsonRpcErrorCode.ValidationError, 'empty_workbook'],
    [{ sheets: 'wrong' }, JsonRpcErrorCode.InvalidParams, 'invalid_arguments'],
  ] as const) {
    const result = await runToolContract(
      exportSpreadsheetTool,
      input as unknown as Parameters<typeof exportSpreadsheetTool.handler>[0],
      {
        context: { tenantId: 'integration' },
      },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code, data: { reason } } },
    });
    expect(JSON.stringify(result.content)).toContain(reason);
  }
});

beforeEach(() => {
  resetServerConfig();
  initRenderService();
  initDocumentStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetServerConfig();
});

/** Asserts domain reason, code and the declared hint on both MCP surfaces. */
function assertDomainFailure(
  result: Awaited<ReturnType<typeof runToolContract>>,
  reason: string,
  recovery: string,
  code = JsonRpcErrorCode.ValidationError,
): void {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { error: { code, data: { reason, recovery: { hint: recovery } } } },
  });
  expect(JSON.stringify(result.content)).toContain(reason);
  expect(
    result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  ).toContain(recovery);
}

it('covers semantic service failures and keeps their recovery on both surfaces', async () => {
  for (const [input, reason] of [
    [{ source: { template: '{{a.b.c}}', data: { a: { b: {} } } } }, 'template_render_failed'],
    [{ source: { html: 'body', data: {} } }, 'invalid_source'],
  ] as const) {
    const result = await runToolContract(renderPdfTool, input);
    const contract = renderPdfTool.errors?.find((entry) => entry.reason === reason);
    assertDomainFailure(result, reason, contract?.recovery as string);
  }
  const invalidSheet = await runToolContract(exportSpreadsheetTool, {
    sheets: [{ name: 'Bad/Name', rows: [] }],
  });
  assertDomainFailure(
    invalidSheet,
    'invalid_sheet_name',
    exportSpreadsheetTool.errors?.find((entry) => entry.reason === 'invalid_sheet_name')
      ?.recovery as string,
  );
  vi.stubEnv('DOCGEN_MAX_DOCUMENT_BYTES', '1');
  resetServerConfig();
  const tooLarge = await runToolContract(renderPdfTool, { source: { markdown: 'body' } });
  assertDomainFailure(
    tooLarge,
    'document_too_large',
    renderPdfTool.errors?.find((entry) => entry.reason === 'document_too_large')
      ?.recovery as string,
  );
});

it('preserves form-source failures through fill and inventory tool contracts', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const flat = Buffer.from(await pdf.save()).toString('base64');
  const cases = [
    [{}, 'invalid_source'],
    [{ base64: 'JVBERi0=', url: 'https://example.com/form.pdf' }, 'invalid_source'],
    [{ base64: 'not!base64' }, 'invalid_pdf_source'],
    [{ base64: Buffer.from('not a PDF').toString('base64') }, 'invalid_pdf_source'],
    [{ base64: flat }, 'not_a_form'],
    [{ url: 'https://127.0.0.1/form.pdf' }, 'source_unfetchable'],
  ] as const;
  for (const definition of [fillFormTool, listFormFieldsTool]) {
    for (const [sourcePdf, reason] of cases) {
      const result =
        definition.name === 'docgen_fill_form'
          ? await runToolContract(fillFormTool, { sourcePdf, fields: {} })
          : await runToolContract(listFormFieldsTool, { sourcePdf });
      const contract = definition.errors?.find((entry) => entry.reason === reason);
      assertDomainFailure(
        result,
        reason,
        contract?.recovery as string,
        reason === 'source_unfetchable'
          ? JsonRpcErrorCode.ServiceUnavailable
          : JsonRpcErrorCode.ValidationError,
      );
    }
  }
});

it('returns the complete inventory through structured and text surfaces', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const field = pdf.getForm().createDropdown('applicant.contact.region');
  field.addOptions(['west', 'east']);
  field.enableRequired();
  field.addToPage(page);
  const expected = {
    fields: [
      {
        name: 'applicant.contact.region',
        type: 'dropdown',
        required: true,
        options: ['west', 'east'],
      },
    ],
  };
  const result = await runToolContract(listFormFieldsTool, {
    sourcePdf: { base64: Buffer.from(await pdf.save()).toString('base64') },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual(expected);
  const domain = result.content.find((block) => block.type === 'text');
  expect(JSON.parse((domain as { text: string }).text)).toEqual(expected);
});

it('preserves inventory schema rejection and timeout contracts', async () => {
  const invalid = await runToolContract(listFormFieldsTool, {
    sourcePdf: 'wrong',
  } as unknown as Parameters<typeof listFormFieldsTool.handler>[0]);
  expect(invalid).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    },
  });
  vi.stubEnv('DOCGEN_RENDER_TIMEOUT_MS', '10');
  resetServerConfig();
  vi.spyOn(PDFDocument, 'load').mockReturnValue(new Promise(() => {}));
  vi.useFakeTimers();
  const pending = runToolContract(listFormFieldsTool, { sourcePdf: { base64: 'JVBERi0=' } });
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  assertDomainFailure(
    result,
    'render_timeout',
    listFormFieldsTool.errors?.find((entry) => entry.reason === 'render_timeout')
      ?.recovery as string,
    JsonRpcErrorCode.Timeout,
  );
});

it('discloses substituted PDF text on both production enrichment surfaces', async () => {
  const result = await runToolContract(renderPdfTool, {
    source: { markdown: '你好' },
    pageOptions: { footer: '你好 {{page}}' },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ degraded: true });
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  expect(text.split('\n')).toContain('**degraded:** true');
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
      code: JsonRpcErrorCode.ValidationError,
      reason: 'empty_workbook',
    },
  ],
});
