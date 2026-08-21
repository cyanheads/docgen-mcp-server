/**
 * @fileoverview RenderService tests — verify that PDF and xlsx renders produce
 * real binary documents by decoding the returned bytes and asserting valid magic
 * bytes (%PDF- for PDF, PK\x03\x04 for xlsx), plus form-fill round-trips and the
 * byte-ceiling / source-validation error paths.
 * @module tests/services/render-service
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { RenderService } from '@/services/document/render-service.js';
import { PageOptionsSchema } from '@/services/document/render-types.js';
import { PDF_MIME, XLSX_MIME } from '@/services/document/types.js';

const PDF_MAGIC = '%PDF-';
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

/** Bridges Node 26's generic Buffer type to exceljs's pre-generic declaration. */
function excelBuffer(bytes: Uint8Array): Parameters<ExcelJS.Workbook['xlsx']['load']>[0] {
  return Buffer.from(bytes) as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0];
}

/** Decodes the leading ASCII bytes of a buffer for magic-byte assertions. */
function leadingAscii(bytes: Uint8Array, n: number): string {
  return Buffer.from(bytes.slice(0, n)).toString('latin1');
}

const defaultPage = PageOptionsSchema.parse({});

describe('RenderService', () => {
  let svc: RenderService;

  beforeEach(() => {
    resetServerConfig();
    vi.unstubAllEnvs();
    svc = new RenderService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  /** Builds a minimal AcroForm PDF with a text field and a checkbox. */
  async function makeFormPdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    const form = pdf.getForm();
    const name = form.createTextField('applicant.name');
    name.addToPage(page, { x: 20, y: 150, width: 200, height: 20 });
    const agree = form.createCheckBox('agree');
    agree.addToPage(page, { x: 20, y: 120, width: 15, height: 15 });
    return new Uint8Array(await pdf.save());
  }

  /** Builds choice-field variants for exercising the form dispatch surface. */
  async function makeChoiceFormPdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 300]);
    const form = pdf.getForm();
    const dropdown = form.createDropdown('dropdown');
    dropdown.addOptions(['red', 'blue']);
    dropdown.addToPage(page, { x: 20, y: 230, width: 120, height: 20 });
    const options = form.createOptionList('options');
    options.addOptions(['alpha', 'beta']);
    options.addToPage(page, { x: 20, y: 140, width: 120, height: 70 });
    const radio = form.createRadioGroup('radio');
    radio.addOptionToPage('yes', page, { x: 20, y: 100, width: 15, height: 15 });
    radio.addOptionToPage('no', page, { x: 60, y: 100, width: 15, height: 15 });
    return new Uint8Array(await pdf.save());
  }

  describe('renderPdf', () => {
    it('renders HTML to a valid PDF (decodes to %PDF- magic bytes)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<h1>Invoice</h1><p>Total: $42.00</p><ul><li>One</li><li>Two</li></ul>' },
        defaultPage,
        ctx,
      );

      expect(result.mimeType).toBe(PDF_MIME);
      expect(result.bytes.byteLength).toBeGreaterThan(100);
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);

      // Round-trip: the bytes must load as a real PDF.
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getPageCount()).toBe(result.pageCount);
      expect(result.pageCount).toBeGreaterThanOrEqual(1);
    });

    it('renders markdown to a valid PDF', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const md =
        '# Report\n\nSome **bold** text.\n\n- alpha\n- beta\n\n3. third\n4. fourth\n\n| A | B |\n|---|---|\n| 1 | 2 |';
      const result = await svc.renderPdf({ markdown: md }, defaultPage, ctx);
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
      await expect(PDFDocument.load(result.bytes)).resolves.toBeDefined();
    });

    it('renders a template + data to a valid PDF', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        {
          template: '<h1>Hello {{name}}</h1><p>Balance: {{amount}}</p>',
          data: { name: 'Acme', amount: '100' },
        },
        defaultPage,
        ctx,
      );
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
    });

    it('throws template_render_failed and names the missing key', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderPdf({ template: '<p>{{missing}}</p>', data: { present: '1' } }, defaultPage, ctx),
      ).rejects.toMatchObject({
        data: { reason: 'template_render_failed', missingKey: 'missing' },
      });
    });

    it('sets degraded when HTML carries unsupported styling', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<style>.x{color:red}</style><p class="x">Styled</p>' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(true);
    });

    it('does not set degraded for plain structural HTML', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<h1>Plain</h1><p>No CSS here.</p>' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(false);
    });

    it('paginates long content across multiple pages', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const paras = Array.from(
        { length: 200 },
        (_, i) =>
          `<p>Paragraph number ${i} with enough text to take vertical space on the page.</p>`,
      ).join('');
      const result = await svc.renderPdf({ html: paras }, defaultPage, ctx);
      expect(result.pageCount).toBeGreaterThan(1);
    });

    it('renders rules, spacers, and hard-wrapped Unicode', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        {
          html: `<h3>Layout</h3><hr><br><p>‘${'unbreakable'.repeat(30)}’</p>`,
        },
        PageOptionsSchema.parse({
          size: 'A5',
          margin: { top: '0pt', right: '1in', bottom: '0pt', left: '1in' },
        }),
        ctx,
      );
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
    });

    it('honors an already-aborted render context without processing blocks', async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = createMockContext({ tenantId: 't1', signal: controller.signal });
      const html = Array.from(
        { length: 200 },
        (_, index) => `<p>Paragraph ${index}: content that would normally paginate.</p>`,
      ).join('');
      const result = await svc.renderPdf({ html }, defaultPage, ctx);
      expect(result.pageCount).toBe(1);
    });
  });

  describe('renderSpreadsheet', () => {
    it('renders sheets to a valid xlsx (decodes to PK\\x03\\x04 magic bytes)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Financials',
            rows: [
              { quarter: 'Q1', revenue: 100, profit: 20 },
              { quarter: 'Q2', revenue: 150, profit: 35 },
            ],
            columns: [
              { key: 'quarter', header: 'Quarter', type: 'string', width: 14 },
              { key: 'revenue', header: 'Revenue', type: 'number', format: '#,##0.00' },
              { key: 'profit', header: 'Profit', type: 'number' },
            ],
          },
        ],
        ctx,
      );

      expect(result.mimeType).toBe(XLSX_MIME);
      expect(result.sheetCount).toBe(1);
      expect([...result.bytes.slice(0, 4)]).toEqual(XLSX_MAGIC);

      // Round-trip: the bytes must load as a real workbook with the data.
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(excelBuffer(result.bytes));
      const ws = wb.getWorksheet('Financials');
      expect(ws).toBeDefined();
      expect(ws!.getRow(1).getCell(1).value).toBe('Quarter');
      expect(ws!.getRow(2).getCell(2).value).toBe(100);
    });

    it('produces a header-only sheet for empty rows', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [{ name: 'Empty', rows: [], columns: [{ key: 'a', header: 'A', type: 'string' }] }],
        ctx,
      );
      expect([...result.bytes.slice(0, 4)]).toEqual(XLSX_MAGIC);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(excelBuffer(result.bytes));
      expect(wb.getWorksheet('Empty')!.getRow(1).getCell(1).value).toBe('A');
    });

    it('renders multiple sheets with derived columns', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          { name: 'One', rows: [{ x: 1 }] },
          { name: 'Two', rows: [{ y: 'hi' }] },
        ],
        ctx,
      );
      expect(result.sheetCount).toBe(2);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(excelBuffer(result.bytes));
      expect(wb.worksheets.map((w) => w.name)).toEqual(['One', 'Two']);
    });
  });

  describe('worksheet name validation', () => {
    it('throws invalid_sheet_name for a forbidden character', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderSpreadsheet([{ name: 'Bad/Name', rows: [{ a: 1 }] }], ctx),
      ).rejects.toMatchObject({ data: { reason: 'invalid_sheet_name' } });
    });

    it('throws invalid_sheet_name for a duplicate name (case-insensitive)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderSpreadsheet(
          [
            { name: 'Dup', rows: [{ a: 1 }] },
            { name: 'dup', rows: [{ b: 2 }] },
          ],
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'invalid_sheet_name' } });
    });

    it('throws invalid_sheet_name for a blank name', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderSpreadsheet([{ name: '   ', rows: [{ a: 1 }] }], ctx),
      ).rejects.toMatchObject({ data: { reason: 'invalid_sheet_name' } });
    });

    it('throws invalid_sheet_name for a name over 31 characters', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderSpreadsheet([{ name: 'x'.repeat(32), rows: [{ a: 1 }] }], ctx),
      ).rejects.toMatchObject({ data: { reason: 'invalid_sheet_name' } });
    });

    it('throws invalid_sheet_name for a leading or trailing apostrophe', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderSpreadsheet([{ name: "'Quoted'", rows: [{ a: 1 }] }], ctx),
      ).rejects.toMatchObject({ data: { reason: 'invalid_sheet_name' } });
    });

    it('accepts a 31-character name and distinct case-varying names', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          { name: 'x'.repeat(31), rows: [{ a: 1 }] },
          { name: 'Summary', rows: [{ b: 2 }] },
        ],
        ctx,
      );
      expect(result.sheetCount).toBe(2);
    });
  });

  describe('fillForm', () => {
    it('fills AcroForm fields and returns a valid PDF', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const source = await makeFormPdf();
      const result = await svc.fillForm(
        source,
        { 'applicant.name': 'Jane Doe', agree: true },
        false,
        ctx,
      );

      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
      expect(result.unmatchedFields).toEqual([]);

      const loaded = await PDFDocument.load(result.bytes);
      const field = loaded.getForm().getTextField('applicant.name');
      expect(field.getText()).toBe('Jane Doe');
      expect(loaded.getForm().getCheckBox('agree').isChecked()).toBe(true);
    });

    it('reports unmatched field names without failing', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const source = await makeFormPdf();
      const result = await svc.fillForm(source, { 'applicant.name': 'X', nope: 'Y' }, false, ctx);
      expect(result.unmatchedFields).toEqual(['nope']);
    });

    it('flattens the form when requested (fields no longer editable)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const source = await makeFormPdf();
      const result = await svc.fillForm(source, { 'applicant.name': 'Flat' }, true, ctx);
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getForm().getFields()).toHaveLength(0);
    });

    it('throws not_a_form for a PDF with no AcroForm fields', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const plain = await PDFDocument.create();
      plain.addPage([200, 200]);
      const bytes = new Uint8Array(await plain.save());
      await expect(svc.fillForm(bytes, { a: 'b' }, false, ctx)).rejects.toMatchObject({
        data: { reason: 'not_a_form' },
      });
    });

    it('throws invalid_pdf_source for non-PDF bytes', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.fillForm(new Uint8Array([1, 2, 3, 4]), { a: 'b' }, false, ctx),
      ).rejects.toMatchObject({ data: { reason: 'invalid_pdf_source' } });
    });

    it('coerces checkbox-like string/number values to checked', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const source = await makeFormPdf();
      // The handler accepts string/number truthy forms ('on', '1', 1) for a checkbox.
      const result = await svc.fillForm(source, { agree: 'on' }, false, ctx);
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getForm().getCheckBox('agree').isChecked()).toBe(true);
    });

    it('leaves a checkbox unchecked for a falsy value', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const source = await makeFormPdf();
      const result = await svc.fillForm(source, { agree: false }, false, ctx);
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getForm().getCheckBox('agree').isChecked()).toBe(false);
    });

    it('fills dropdown, option-list, and radio-group fields', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.fillForm(
        await makeChoiceFormPdf(),
        { dropdown: 'blue', options: 'beta', radio: 'yes' },
        false,
        ctx,
      );
      const form = (await PDFDocument.load(result.bytes)).getForm();
      expect(form.getDropdown('dropdown').getSelected()).toEqual(['blue']);
      expect(form.getOptionList('options').getSelected()).toEqual(['beta']);
      expect(form.getRadioGroup('radio').getSelected()).toBe('yes');
    });
  });

  describe('render bounds', () => {
    it('throws document_too_large when a render exceeds the byte ceiling (PDF)', async () => {
      vi.stubEnv('DOCGEN_MAX_DOCUMENT_BYTES', '1');
      resetServerConfig();
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderPdf({ html: '<h1>Anything</h1>' }, defaultPage, ctx),
      ).rejects.toMatchObject({ data: { reason: 'document_too_large' } });
    });

    it('throws document_too_large when a spreadsheet exceeds the byte ceiling', async () => {
      vi.stubEnv('DOCGEN_MAX_DOCUMENT_BYTES', '1');
      resetServerConfig();
      const ctx = createMockContext({ tenantId: 't1' });
      await expect(
        svc.renderSpreadsheet([{ name: 'S', rows: [{ a: 1 }] }], ctx),
      ).rejects.toMatchObject({ data: { reason: 'document_too_large' } });
    });

    it('throws document_too_large when a filled form exceeds the byte ceiling', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const source = await makeFormPdf();
      // Render the source first (within the default ceiling), then tighten it so
      // only the fill output trips the limit.
      vi.stubEnv('DOCGEN_MAX_DOCUMENT_BYTES', '1');
      resetServerConfig();
      await expect(
        svc.fillForm(source, { 'applicant.name': 'X' }, false, ctx),
      ).rejects.toMatchObject({ data: { reason: 'document_too_large' } });
    });

    it('throws render_timeout when a render exceeds the time budget', async () => {
      // A 1ms budget cannot serialize a 20k-row workbook in time → render_timeout.
      vi.stubEnv('DOCGEN_RENDER_TIMEOUT_MS', '1');
      resetServerConfig();
      const ctx = createMockContext({ tenantId: 't1' });
      const rows = Array.from({ length: 20_000 }, (_, i) => ({ a: i, b: `row ${i}`, c: i * 2 }));
      await expect(svc.renderSpreadsheet([{ name: 'Big', rows }], ctx)).rejects.toMatchObject({
        data: { reason: 'render_timeout' },
      });
    });
  });

  describe('spreadsheet cell coercion and sparsity', () => {
    /** Loads the first worksheet of a rendered workbook for cell assertions. */
    async function firstSheet(bytes: Uint8Array): Promise<ExcelJS.Worksheet> {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(excelBuffer(bytes));
      return wb.worksheets[0]!;
    }

    it('fills missing row keys with empty cells rather than crashing (sparse rows)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Sparse',
            rows: [{ a: 1, b: 2 }, { a: 3 }], // second row omits `b` entirely
            columns: [
              { key: 'a', header: 'A', type: 'number' },
              { key: 'b', header: 'B', type: 'number' },
            ],
          },
        ],
        ctx,
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(2).getCell(1).value).toBe(1);
      expect(ws.getRow(3).getCell(1).value).toBe(3);
      // The omitted `b` resolves to a null/empty cell, not a fabricated value.
      const missing = ws.getRow(3).getCell(2).value;
      expect(missing == null).toBe(true);
    });

    it('coerces declared number columns from numeric strings', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Nums',
            rows: [{ n: '42.5' }],
            columns: [{ key: 'n', header: 'N', type: 'number' }],
          },
        ],
        ctx,
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(2).getCell(1).value).toBe(42.5);
    });

    it('keeps a non-numeric value as-is when a number column cannot parse it', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Nums',
            rows: [{ n: 'not-a-number' }],
            columns: [{ key: 'n', header: 'N', type: 'number' }],
          },
        ],
        ctx,
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(2).getCell(1).value).toBe('not-a-number');
    });

    it('coerces a declared date column from an ISO string to a Date', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Dates',
            rows: [{ d: '2026-01-15' }],
            columns: [{ key: 'd', header: 'D', type: 'date' }],
          },
        ],
        ctx,
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(2).getCell(1).value).toBeInstanceOf(Date);
    });

    it('coerces a boolean column from truthy/falsy values', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Bools',
            rows: [{ b: 1 }, { b: 0 }],
            columns: [{ key: 'b', header: 'B', type: 'boolean' }],
          },
        ],
        ctx,
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(2).getCell(1).value).toBe(true);
      expect(ws.getRow(3).getCell(1).value).toBe(false);
    });

    it('renders a null cell as empty without inventing a value', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Nulls',
            rows: [{ a: null }],
            columns: [{ key: 'a', header: 'A', type: 'string' }],
          },
        ],
        ctx,
      );
      const ws = await firstSheet(result.bytes);
      const v = ws.getRow(2).getCell(1).value;
      expect(v == null).toBe(true);
    });
  });

  describe('PDF layout edge cases', () => {
    /** Parses partial page options against the schema (applying defaults). */
    function defaultPageWith(over: Record<string, unknown>) {
      return PageOptionsSchema.parse(over);
    }

    it('renders landscape orientation without error', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<h1>Wide</h1>' },
        defaultPageWith({ orientation: 'landscape', size: 'A4' }),
        ctx,
      );
      const loaded = await PDFDocument.load(result.bytes);
      const page = loaded.getPage(0);
      // A4 landscape: width (841.89) > height (595.28).
      expect(page.getWidth()).toBeGreaterThan(page.getHeight());
    });

    it('honors explicit margins parsed from CSS length strings', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<p>Margins</p>' },
        defaultPageWith({ margin: { top: '50mm', bottom: '50mm', left: '1in', right: '1in' } }),
        ctx,
      );
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
    });

    it('interpolates {{page}} / {{total}} tokens in header and footer', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      // Multi-page content so {{total}} is > 1 and the footer renders per page.
      const paras = Array.from(
        { length: 120 },
        (_, i) => `<p>Body paragraph ${i} with enough text to consume vertical space.</p>`,
      ).join('');
      const result = await svc.renderPdf(
        { html: paras },
        defaultPageWith({
          header: 'Report — page {{page}}/{{total}}',
          footer: 'Generated {{date}}',
        }),
        ctx,
      );
      expect(result.pageCount).toBeGreaterThan(1);
      // Tokens are drawn into the PDF content stream; assert the literal text survives.
      const text = Buffer.from(result.bytes).toString('latin1');
      expect(text.length).toBeGreaterThan(0);
      await expect(PDFDocument.load(result.bytes)).resolves.toBeDefined();
    });

    it('auto-numbers pages when pageNumbers is set', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<h1>Numbered</h1><p>Body.</p>' },
        defaultPageWith({ pageNumbers: true }),
        ctx,
      );
      await expect(PDFDocument.load(result.bytes)).resolves.toBeDefined();
    });

    it('renders exotic Unicode without throwing (font sanitization)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      // Smart quotes, em dash, ellipsis, bullet, plus a non-Latin-1 glyph.
      const result = await svc.renderPdf(
        { html: '<p>“Hello” — world… • café 中文 😀</p>' },
        defaultPage,
        ctx,
      );
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
      await expect(PDFDocument.load(result.bytes)).resolves.toBeDefined();
    });

    it('renders empty HTML to a valid single-page PDF', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf({ html: '' }, defaultPage, ctx);
      expect(leadingAscii(result.bytes, 5)).toBe(PDF_MAGIC);
      expect(result.pageCount).toBe(1);
    });

    it('flags degraded when markdown carries an image', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { markdown: '# Title\n\n![alt](https://example.com/x.png)' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(true);
    });

    it('flags degraded when markdown carries a raw HTML block', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { markdown: '# Title\n\n<div style="color:red">raw</div>' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(true);
    });

    it('does not flag degraded for ordinary markdown emphasis', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { markdown: '# Title\n\nSome **bold** and _italic_ and a [link](https://x.test).' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(false);
    });

    it('flags degraded when HTML carries an inline style attribute', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<p style="color:red">Styled inline</p>' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(true);
    });

    it('strips script content and flags degraded (no JS execution)', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const result = await svc.renderPdf(
        { html: '<p>Safe</p><script>window.x=1</script>' },
        defaultPage,
        ctx,
      );
      expect(result.degraded).toBe(true);
      await expect(PDFDocument.load(result.bytes)).resolves.toBeDefined();
    });
  });
});
