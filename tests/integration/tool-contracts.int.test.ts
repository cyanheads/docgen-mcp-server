/**
 * @fileoverview Production-shaped SDK v2 contract coverage for docgen tools.
 * @module tests/integration/tool-contracts.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import ExcelJS from 'exceljs';
import { Lexer, type Tokens } from 'marked';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { exportSpreadsheetTool } from '@/mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { fillFormTool } from '@/mcp-server/tools/definitions/fill-form.tool.js';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { listFormFieldsTool } from '@/mcp-server/tools/definitions/list-form-fields.tool.js';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { getDocumentStore, initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

it('exports offsetless dates as UTC, invalid dates as text, and blank dates as empty cells', async () => {
  const cases = [
    ['2026-03-04T10:00', new Date('2026-03-04T10:00Z')],
    ['2026-03-04T10:00:23.456', new Date('2026-03-04T10:00:23.456Z')],
    ['12', '12'],
    ['03/04/2026', '03/04/2026'],
    ['March 4, 2026', 'March 4, 2026'],
    ['2026-02-30', '2026-02-30'],
    ['2026-02-29T10:00+03:00', '2026-02-29T10:00+03:00'],
    ['2026-03-04T24:00:00.0001Z', '2026-03-04T24:00:00.0001Z'],
    ['2026-03-04T23:59:60Z', '2026-03-04T23:59:60Z'],
    ['2026-03-04T10:00+24:00', '2026-03-04T10:00+24:00'],
    ['2026-03', '2026-03'],
    ['2026', '2026'],
    [' 2026-03-04 ', ' 2026-03-04 '],
    ['', null],
    ['  ', null],
  ] as const;
  const result = await runToolContract(exportSpreadsheetTool, {
    sheets: [
      {
        name: 'Dates',
        rows: cases.map(([date], id) => ({ date, id })),
        columns: [
          { key: 'date', header: 'Date', type: 'date' },
          { key: 'id', header: 'ID', type: 'number' },
        ],
      },
    ],
  });
  expect(result.isError).not.toBe(true);
  const { document } = exportSpreadsheetTool.output.parse(result.structuredContent);
  const text = result.content.find((block) => block.type === 'text')?.text;
  assert(document.inlineBase64 !== undefined, 'Expected inline spreadsheet bytes.');
  expect(text?.split('\n')).toContain(`**Inline document (base64):** ${document.inlineBase64}`);
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.from(document.inlineBase64, 'base64');
  await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
  const sheet = workbook.getWorksheet('Dates');
  assert(sheet, 'Expected the Dates worksheet.');
  expect(cases.map((_, index) => sheet.getCell(index + 2, 1).value)).toEqual(
    cases.map(([, expected]) => expected),
  );
});

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
  const recoveryParagraph = result.content
    .filter((block) => block.type === 'text')
    .flatMap((block) => new Lexer({ gfm: false }).lex(block.text))
    .find(
      (token): token is Tokens.Paragraph =>
        token.type === 'paragraph' && token.raw.startsWith('Recovery: '),
    );
  expect(
    recoveryParagraph?.tokens
      .map((token) => (token.type === 'escape' ? token.text : token.raw))
      .join(''),
  ).toBe(`Recovery: ${recovery}`);
}

it('covers semantic service failures and keeps their recovery on both surfaces', async () => {
  for (const [input, reason] of [
    [{ source: { template: '{{a.b.c}}', data: { a: { b: {} } } } }, 'template_render_failed'],
    [
      { source: { template: '{{#if vip}}VIP{{/if}}', data: { vip: false } } },
      'template_render_failed',
    ],
    [
      { source: { html: '<p>Body</p>' }, pageOptions: { margin: { top: '400mm' } } },
      'invalid_page_margins',
    ],
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

it('returns the rendered PDF envelope and WinAnsi status on both production surfaces', async () => {
  const result = await runToolContract(renderPdfTool, {
    source: { template: '<p>{{amount}}</p>', data: { amount: '€5' } },
  });
  expect(result.structuredContent).toMatchObject({ document: { pageCount: 1 }, degraded: false });
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('**degraded:** false'),
      }),
    ]),
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
  field.select('west');
  field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Which region?'));
  const expected = {
    fields: [
      {
        name: 'applicant.contact.region',
        type: 'dropdown',
        required: true,
        options: ['west', 'east'],
        value: ['west'],
        label: 'Which region?',
        page: 1,
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

it('reports form assignment results and notices on both MCP surfaces', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const form = pdf.getForm();
  const dropdown = form.createDropdown('parent.child.color');
  dropdown.addOptions(['blue']);
  dropdown.addToPage(page);
  form.createCheckBox('agree').addToPage(page);
  const result = await runToolContract(fillFormTool, {
    sourcePdf: { base64: Buffer.from(await pdf.save()).toString('base64') },
    fields: { color: 'B[L]UE `one`\nnext', agree: 'maybe', missing: true },
    flatten: true,
  });
  const assignmentReport = {
    unmatchedFields: ['missing'],
    resolvedFields: [{ requested: 'color', resolved: 'parent.child.color' }],
    madeEditableFields: ['parent.child.color'],
  };
  expect(result.isError).not.toBe(true);
  const notices = [
    'Made "parent.child.color" editable to enter "B[L]UE `one`\\nnext".',
    'Unchecked "agree" because "maybe" is an unrecognized checkbox value.',
  ];
  expect(result.structuredContent).toMatchObject({ ...assignmentReport, notices });
  const reports = result.content
    .filter((block) => block.type === 'text')
    .flatMap((block) => new Lexer({ gfm: false }).lex(block.text))
    .filter((token): token is Tokens.Code => token.type === 'code' && token.lang === 'json')
    .map((token) => JSON.parse(token.text));
  expect(reports).toEqual([assignmentReport, notices]);
});

it('returns aggregate form validation and recovery on both surfaces without storing a document', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const form = pdf.getForm();
  const text = form.createTextField('short');
  text.setMaxLength(2);
  text.addToPage(page);
  form.createTextField('visible').addToPage(page);
  const put = vi.spyOn(getDocumentStore(), 'put');
  const result = await runToolContract(fillFormTool, {
    sourcePdf: { base64: Buffer.from(await pdf.save()).toString('base64') },
    fields: { short: 'abc', visible: 'Ł' },
  });
  const recovery = fillFormTool.errors?.find(
    (entry) => entry.reason === 'invalid_field_value',
  )?.recovery;
  expect(recovery).toBeDefined();
  assertDomainFailure(result, 'invalid_field_value', recovery!);
  for (const surface of [result.structuredContent, result.content]) {
    expect(JSON.stringify(surface)).toMatch(/short.*maximum length of 2.*visible.*Ł/s);
  }
  expect(put).not.toHaveBeenCalled();
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
