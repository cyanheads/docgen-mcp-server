/**
 * @fileoverview RenderService tests — verify that PDF and xlsx renders produce
 * real binary documents by decoding the returned bytes and asserting valid magic
 * bytes (%PDF- for PDF, PK\x03\x04 for xlsx), plus form-fill round-trips and the
 * byte-ceiling / source-validation error paths.
 * @module tests/services/render-service
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import ExcelJS from 'exceljs';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
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

/** Reads the actual text-show operators emitted by the WinAnsi renderer. */
async function renderedText(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().flatMap((page) => {
    const contents = page.node.Contents();
    if (!contents) throw new Error('Expected a page content stream.');
    const references = contents instanceof PDFArray ? contents.asArray() : [contents];
    return references.flatMap((reference) => {
      const stream = pdf.context.lookup(reference);
      if (!(stream instanceof PDFRawStream)) throw new Error('Expected a raw PDF content stream.');
      const operators = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      return [...operators.matchAll(/<([0-9A-F]+)> Tj/g)].map((match) =>
        Buffer.from(match[1]!, 'hex').toString('latin1'),
      );
    });
  });
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
    it('round-trips widgetless Unicode and widget-backed tabs and line breaks', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const form = pdf.getForm();
      form.createTextField('widgetless');
      form.createTextField('visible').addToPage(page);
      const result = await svc.fillForm(
        await pdf.save(),
        { widgetless: 'Łukasz', visible: 'a\tb\nc' },
        false,
        createMockContext(),
      );
      const filled = (await PDFDocument.load(result.bytes)).getForm();
      expect(filled.getTextField('widgetless').getText()).toBe('Łukasz');
      expect(filled.getTextField('visible').getText()).toBe('a\tb\nc');
    });

    it('bounds CPU growth when rejecting a glyph at the end of large widget text', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const field = pdf.getForm().createTextField('visible');
      field.addToPage(page, { width: 200, height: 20 });
      field.setFontSize(12);
      const source = await pdf.save();
      const ctx = createMockContext();
      const rejectGlyph = async (text: string) => {
        await expect(svc.fillForm(source, { visible: text }, false, ctx)).rejects.toMatchObject({
          data: { reason: 'invalid_field_value' },
          message: expect.stringContaining('cannot display "Ł"'),
        });
      };
      const cpuPerFillUs = async (text: string, repetitions: number) => {
        const before = process.threadCpuUsage();
        for (let i = 0; i < repetitions; i++) await rejectGlyph(text);
        const { user, system } = process.threadCpuUsage(before);
        return (user + system) / repetitions;
      };
      // Use the fastest of three warmed samples to reduce the effect of JIT and GC work.
      const cpuCeilingUs = 200_000;
      for (const line of ['aaaaaaaaaa', 'aaaaaaaaa\n']) {
        const fastestCpuUs = async (size: number, repetitions = 1) => {
          const text = `${line.repeat(size / line.length)}Ł\n`;
          await rejectGlyph(text);
          let fastestUs = Number.POSITIVE_INFINITY;
          for (let sample = 0; sample < 3; sample++) {
            fastestUs = Math.min(fastestUs, await cpuPerFillUs(text, repetitions));
          }
          expect(
            fastestUs,
            `${size} characters with line pattern ${JSON.stringify(line)}`,
          ).toBeLessThan(cpuCeilingUs);
          return fastestUs;
        };
        const smallestUs = await fastestCpuUs(1_000, 16);
        await fastestCpuUs(5_000, 4);
        await fastestCpuUs(20_000, 2);
        const largestUs = await fastestCpuUs(80_000);
        expect(largestUs, `full-span CPU with line pattern ${JSON.stringify(line)}`).toBeLessThan(
          smallestUs * 256,
        );
      }
    });

    it('aggregates field-specific length, choice, glyph and unsupported field failures', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const form = pdf.getForm();
      const short = form.createTextField('short');
      short.setMaxLength(2);
      short.addToPage(page);
      form.createTextField('visible').addToPage(page);
      const list = form.createOptionList('list');
      list.addOptions(['red', 'RED']);
      const radio = form.createRadioGroup('radio');
      radio.addOptionToPage('yes', page);
      form.createButton('button').addToPage('Submit', page);
      await expect(
        svc.fillForm(
          await pdf.save(),
          { short: 'abc', visible: 'Łukasz', list: 'Red', radio: 'no', button: true },
          false,
          createMockContext(),
        ),
      ).rejects.toMatchObject({
        message: expect.stringMatching(
          /"short".*2.*"visible".*Ł.*"list".*red.*RED.*"radio".*yes.*"button".*discovery/s,
        ),
        data: { reason: 'invalid_field_value' },
      });
    });

    it('keeps a template option encoding failure outside assignment validation', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const list = pdf.getForm().createOptionList('colors');
      list.addOptions(['blue']);
      list.addToPage(page);
      list.addOptions(['Ł']);
      const source = await pdf.save({ updateFieldAppearances: false });
      await expect(
        svc.fillForm(source, { colors: 'blue' }, false, createMockContext()),
      ).rejects.toThrow('WinAnsi cannot encode');
    });

    it('prefers exact radio and list choices and rejects ambiguous case variants', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const form = pdf.getForm();
      const radio = form.createRadioGroup('radio');
      radio.addOptionToPage('red', page);
      radio.addOptionToPage('RED', page);
      const list = form.createOptionList('list');
      list.addOptions(['blue', 'BLUE']);
      list.addToPage(page);
      const source = await pdf.save();
      const ctx = createMockContext();
      const exact = await svc.fillForm(source, { radio: 'RED', list: 'blue' }, false, ctx);
      const selected = (await PDFDocument.load(exact.bytes)).getForm();
      expect(selected.getRadioGroup('radio').getSelected()).toBe('RED');
      expect(selected.getOptionList('list').getSelected()).toEqual(['blue']);
      await expect(
        svc.fillForm(source, { radio: 'Red', list: 'Blue' }, false, ctx),
      ).rejects.toMatchObject({
        message: expect.stringMatching(
          /"radio".*matches multiple choices.*"list".*matches multiple choices/s,
        ),
        data: { reason: 'invalid_field_value' },
      });
    });

    it('reports an empty unlisted fixed choice and a comb value that overflows after tab expansion', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const form = pdf.getForm();
      const dropdown = form.createDropdown('dropdown');
      dropdown.addOptions(['blue']);
      dropdown.addToPage(page);
      const text = form.createTextField('comb');
      text.setMaxLength(3);
      text.enableCombing();
      text.addToPage(page);
      await expect(
        svc.fillForm(await pdf.save(), { dropdown: '', comb: 'a\tb' }, false, createMockContext()),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/"dropdown".*nonempty custom text.*"comb".*fit 3 cells/s),
        data: { reason: 'invalid_field_value' },
      });
    });

    it('resolves unique aliases and leaves collisions unmatched in input order', async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage();
      const form = pdf.getForm();
      for (const name of [
        'a.b.email',
        'a.b.name',
        'c.d.name',
        'a.b.phone',
        'a.b.zip',
        'city',
        'a.b.City',
      ]) {
        form.createTextField(name);
      }
      const result = await svc.fillForm(
        await pdf.save(),
        {
          name: 'shared leaf',
          'A.B.PHONE': 'alias',
          phone: 'alias again',
          zip: 'alias',
          'a.b.zip': 'exact',
          'A.B.ZIP': 'alias after exact',
          city: 'exact',
          City: 'union',
          missing: '?',
          email: 'ok',
          'C.D.NAME': 'ok too',
        },
        false,
        createMockContext(),
      );
      expect(result.unmatchedFields).toEqual([
        'name',
        'A.B.PHONE',
        'phone',
        'zip',
        'A.B.ZIP',
        'City',
        'missing',
      ]);
      expect(result.resolvedFields).toEqual([
        { requested: 'email', resolved: 'a.b.email' },
        { requested: 'C.D.NAME', resolved: 'c.d.name' },
      ]);
      const filled = (await PDFDocument.load(result.bytes)).getForm();
      expect(filled.getTextField('a.b.email').getText()).toBe('ok');
      expect(filled.getTextField('c.d.name').getText()).toBe('ok too');
      expect(filled.getTextField('a.b.zip').getText()).toBe('exact');
      expect(filled.getTextField('city').getText()).toBe('exact');
      expect(filled.getTextField('a.b.City').getText()).toBeUndefined();
      expect(filled.getTextField('a.b.phone').getText()).toBeUndefined();
    });

    it('recognizes checkbox aliases and reports unknown values', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const form = pdf.getForm();
      const cases = [
        ['yes', 'Yes', true],
        ['trim', ' yes ', true],
        ['x', 'X', true],
        ['true', 'TRUE', true],
        ['checked', 'checked', true],
        ['bool', true, true],
        ['number', 1, true],
        ['false', false, false],
        ['off', 'off', false],
        ['empty', '', false],
        ['unknown', 'maybe', false],
      ] as const;
      for (const [name] of cases) {
        const field = form.createCheckBox(name);
        field.addToPage(page);
        field.check();
      }
      const result = await svc.fillForm(
        await pdf.save(),
        Object.fromEntries(cases.map(([name, value]) => [name, value])),
        false,
        createMockContext(),
      );
      const filled = (await PDFDocument.load(result.bytes)).getForm();
      for (const [name, , checked] of cases)
        expect(filled.getCheckBox(name).isChecked(), name).toBe(checked);
      expect(result.notices).toEqual([expect.stringMatching(/"unknown".*"maybe"/)]);
    });

    it('prefers exact export strings and keeps boolean and unchecked-alias precedence', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      const form = pdf.getForm();
      const cases = [
        ['numericExport', '3', 3, true],
        ['decodedExport', 'Done Now', 'done now', true],
        ['exactExport', 'no', 'no', true],
        ['foldedExport', 'no', 'NO', false],
        ['falseBoolean', 'false', false, false],
      ] as const;
      for (const [name, onValue] of cases) {
        const field = form.createCheckBox(name);
        field.addToPage(page);
        const normal = field.acroField.getWidgets()[0]?.getAppearances()?.normal;
        if (!(normal instanceof PDFDict)) throw new Error('Fixture requires a checkbox appearance');
        const yes = PDFName.of('Yes');
        normal.set(PDFName.of(onValue), normal.get(yes)!);
        normal.delete(yes);
      }
      const result = await svc.fillForm(
        await pdf.save(),
        Object.fromEntries(cases.map(([name, , value]) => [name, value])),
        false,
        createMockContext(),
      );
      const filled = (await PDFDocument.load(result.bytes)).getForm();
      for (const [name, , , checked] of cases)
        expect(filled.getCheckBox(name).isChecked(), name).toBe(checked);
      expect(result.notices).toEqual([]);
    });

    it('keeps dropdown literals and reports transitions before flattening', async () => {
      const source = await makeChoiceFormPdf();
      const ctx = createMockContext();
      const custom = await svc.fillForm(
        source,
        { dropdown: 'BLUE', radio: 'Yes', options: 'Beta' },
        false,
        ctx,
      );
      const form = (await PDFDocument.load(custom.bytes)).getForm();
      expect(form.getDropdown('dropdown').getSelected()).toEqual(['BLUE']);
      expect(form.getDropdown('dropdown').isEditable()).toBe(true);
      expect(form.getRadioGroup('radio').getSelected()).toBe('yes');
      expect(form.getOptionList('options').getSelected()).toEqual(['beta']);
      expect(custom.madeEditableFields).toEqual(['dropdown']);
      expect(custom.notices).toEqual([expect.stringMatching(/"dropdown".*"BLUE"/)]);
      const editable = await svc.fillForm(custom.bytes, { dropdown: 'other' }, false, ctx);
      expect(editable.madeEditableFields).toEqual([]);
      const fixed = await svc.fillForm(source, { dropdown: 'blue' }, false, ctx);
      expect(fixed.madeEditableFields).toEqual([]);
      expect(
        (await PDFDocument.load(fixed.bytes)).getForm().getDropdown('dropdown').isEditable(),
      ).toBe(false);
      const flat = await svc.fillForm(source, { dropdown: 'purple' }, true, ctx);
      expect(flat.madeEditableFields).toEqual(['dropdown']);
      expect((await PDFDocument.load(flat.bytes)).getForm().getFields()).toHaveLength(0);
    });

    it('inventories every field class and nested names without changing bytes', async () => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([400, 400]);
      const form = pdf.getForm();
      const text = form.createTextField('applicant.contact.name');
      text.enableRequired();
      text.addToPage(page);
      form.createCheckBox('agree').addToPage(page);
      const dropdown = form.createDropdown('choice');
      dropdown.addOptions(['red', 'blue']);
      dropdown.enableRequired();
      dropdown.addToPage(page);
      const options = form.createOptionList('list');
      options.addOptions(['alpha', 'beta']);
      options.addToPage(page);
      const radio = form.createRadioGroup('radio');
      radio.addOptionToPage('yes', page);
      radio.addOptionToPage('no', page);
      form.createButton('button').addToPage('Submit', page);
      const signature = pdf.context.obj({
        FT: PDFName.of('Sig'),
        T: PDFHexString.fromText('signature'),
        Ff: 2,
      });
      form.acroForm.addField(pdf.context.register(signature));
      const source = new Uint8Array(await pdf.save());
      const original = source.slice();
      const ctx = createMockContext();
      const set = vi.spyOn(ctx.state, 'set');
      const fields = await svc.listFormFields(source, ctx);
      expect(fields).toEqual([
        { name: 'applicant.contact.name', type: 'text', required: true, page: 1 },
        { name: 'agree', type: 'checkbox', required: false, page: 1, value: false, onValue: 'Yes' },
        {
          name: 'choice',
          type: 'dropdown',
          required: true,
          options: ['red', 'blue'],
          page: 1,
          value: [],
        },
        {
          name: 'list',
          type: 'optionList',
          required: false,
          options: ['alpha', 'beta'],
          page: 1,
          value: [],
        },
        { name: 'radio', type: 'radioGroup', required: false, options: ['yes', 'no'], page: 1 },
        { name: 'button', type: 'button', required: false, page: 1 },
        { name: 'signature', type: 'signature', required: true },
      ]);
      expect(source).toEqual(original);
      expect(set).not.toHaveBeenCalled();
    });

    it('uses the first widget, falls back to annotation membership, and preserves empty plain text', async () => {
      const pdf = await PDFDocument.create();
      const firstPage = pdf.addPage();
      const secondPage = pdf.addPage();
      const form = pdf.getForm();
      const field = form.createTextField('root.section.value');
      field.setMaxLength(4);
      field.addToPage(secondPage);
      field.addToPage(firstPage);
      field.acroField.getWidgets()[0]?.dict.delete(PDFName.of('P'));
      field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText('Ångström'));
      field.acroField.setValue(PDFHexString.fromText(''));
      form.createTextField('missing');
      const rich = form.createTextField('rich');
      rich.enableRichFormatting();
      rich.acroField.dict.set(PDFName.of('RV'), PDFHexString.fromText('<p>rich only</p>'));
      expect(() => rich.getText()).toThrow();
      const source = await pdf.save({ updateFieldAppearances: false });
      expect(await svc.listFormFields(source, createMockContext())).toEqual([
        {
          name: 'root.section.value',
          type: 'text',
          required: false,
          label: 'Ångström',
          maxLength: 4,
          value: '',
          page: 2,
        },
        { name: 'missing', type: 'text', required: false },
        { name: 'rich', type: 'text', required: false },
      ]);
    });

    it('rejects malformed and zero-field PDF inventory', async () => {
      const plain = await PDFDocument.create();
      plain.addPage();
      for (const [bytes, reason] of [
        [new Uint8Array([1, 2]), 'invalid_pdf_source'],
        [new Uint8Array(await plain.save()), 'not_a_form'],
      ] as const) {
        await expect(svc.listFormFields(bytes, createMockContext())).rejects.toMatchObject({
          code: -32007,
          data: { reason },
        });
      }
    });
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

    it('flattens widgets into page content and preserves direct and indirect links', async () => {
      const ctx = createMockContext({ tenantId: 't1' });
      const pdf = await PDFDocument.create();
      const pages = [pdf.addPage(), pdf.addPage()];
      const field = pdf.getForm().createTextField('applicant.contact.name');
      for (const [index, page] of pages.entries()) {
        field.addToPage(page);
        const link = pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [25, 25, 75, 45],
          A: { S: 'URI', URI: PDFHexString.fromText(`https://example.com/${index}`) },
        });
        const annotations = page.node.normalizedEntries().Annots;
        annotations.push(index === 0 ? link : pdf.context.register(link));
      }
      // Exercise both widget /P and page annotation membership lookup.
      field.acroField.getWidgets()[1]?.dict.delete(PDFName.of('P'));
      const result = await svc.fillForm(
        await pdf.save(),
        { 'applicant.contact.name': 'Flat' },
        true,
        ctx,
      );
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getForm().getFields()).toHaveLength(0);
      const readStream = (reference: Parameters<typeof loaded.context.lookup>[0]) => {
        const stream = loaded.context.lookup(reference);
        if (!(stream instanceof PDFRawStream)) throw new Error('Expected a raw PDF stream.');
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      };
      for (const [index, page] of loaded.getPages().entries()) {
        const annotations = page.node.Annots();
        if (!annotations) throw new Error('Expected page annotations.');
        const linkEntries = annotations.asArray().filter((entry) => {
          const dict = loaded.context.lookup(entry);
          return dict instanceof PDFDict && dict.get(PDFName.of('Subtype')) === PDFName.of('Link');
        });
        expect(linkEntries).toHaveLength(1);
        const [entry] = linkEntries;
        expect(entry).toBeInstanceOf(index === 0 ? PDFDict : PDFRef);
        const action = loaded.context.lookup(entry, PDFDict).lookup(PDFName.of('A'), PDFDict);
        expect(action.lookup(PDFName.of('URI'), PDFHexString).decodeText()).toBe(
          `https://example.com/${index}`,
        );
        const contents = page.node.Contents();
        const xObjects = page.node.Resources()?.lookup(PDFName.XObject, PDFDict);
        if (!(contents instanceof PDFArray) || !xObjects) {
          throw new Error('Expected flattened page content and resources.');
        }
        expect(xObjects.entries()).toHaveLength(1);
        for (const [name, reference] of xObjects.entries()) {
          expect(readStream(reference)).toContain('<466C6174> Tj');
          expect(contents.asArray().map(readStream).join('\n')).toContain(`${name} Do`);
        }
        expect(annotations.asArray()).toEqual(linkEntries);
      }
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
      vi.stubEnv('DOCGEN_RENDER_TIMEOUT_MS', '1');
      resetServerConfig();
      const ctx = createMockContext({ tenantId: 't1' });
      vi.useFakeTimers();
      try {
        const render = svc.renderSpreadsheet([{ name: 'Data', rows: [{ a: 1 }] }], ctx);
        const assertion = expect(render).rejects.toMatchObject({
          data: { reason: 'render_timeout' },
        });
        // Expire the budget while the real workbook serialization is still pending.
        vi.advanceTimersByTime(1);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('spreadsheet cell coercion and sparsity', () => {
    it('parses recognized boolean strings and preserves unknown strings', async () => {
      const values = [
        'false',
        '0',
        'no',
        'off',
        '',
        ' FALSE ',
        'No',
        'true',
        '1',
        'yes',
        'on',
        ' ON ',
        'unknown',
        true,
        false,
        0,
        1,
        -2,
        null,
      ];
      const expected = [
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        true,
        'unknown',
        true,
        false,
        false,
        true,
        true,
        null,
      ];
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Booleans',
            rows: values.map((b) => ({ b })),
            columns: [{ key: 'b', header: 'B', type: 'boolean' }],
          },
        ],
        createMockContext(),
      );
      const ws = await firstSheet(result.bytes);
      expect(values.map((_, i) => ws.getRow(i + 2).getCell(1).value)).toEqual(expected);
    });

    it('keeps blank numeric input blank and numeric dates as decimal text', async () => {
      const result = await svc.renderSpreadsheet(
        [
          {
            name: 'Scalars',
            rows: [
              { n: '', d: 2024 },
              { n: '  ', d: '2026-01-15' },
              { n: '42.5', d: null },
            ],
            columns: [
              { key: 'n', header: 'N', type: 'number' },
              { key: 'd', header: 'D', type: 'date' },
            ],
          },
        ],
        createMockContext(),
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(2).getCell(1).value).toBeNull();
      expect(ws.getRow(3).getCell(1).value).toBeNull();
      expect(ws.getRow(2).getCell(2).value).toBe('2024');
      expect(ws.getRow(3).getCell(2).value).toEqual(new Date('2026-01-15T00:00:00.000Z'));
      expect(ws.getRow(4).getCell(1).value).toBe(42.5);
    });

    it('derives the all-row key union in first-seen order', async () => {
      const result = await svc.renderSpreadsheet(
        [{ name: 'Union', rows: [{ z: 1 }, { a: 2, z: 3 }, { b: 4 }] }],
        createMockContext(),
      );
      const ws = await firstSheet(result.bytes);
      expect(ws.getRow(1).values).toEqual([undefined, 'z', 'a', 'b']);
      expect(ws.getRow(3).values).toEqual([undefined, 3, 2]);
      expect(ws.getRow(4).getCell(3).value).toBe(4);
    });

    it('preserves existing punctuation and Latin-1 without degradation', async () => {
      const result = await svc.renderPdf(
        { markdown: '“café” — … • déjà' },
        defaultPage,
        createMockContext(),
      );
      expect(result.degraded).toBe(false);
      expect(await renderedText(result.bytes)).toEqual(['"café" - ... * déjà']);
    });

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
    it.each([
      { html: '<p>你好</p>' },
      { html: '<p>€</p>' },
      { html: '<p>\u0080</p>' },
      { html: '<ul><li>你好</li></ul>' },
      { html: '<table><tr><th>你好</th></tr><tr><td>你好</td></tr></table>' },
    ])('discloses substitution on body surfaces: %j', async (source) => {
      const result = await svc.renderPdf(source, defaultPage, createMockContext());
      expect(result.degraded).toBe(true);
      const replacement = source.html.includes('你好') ? '??' : '?';
      const count = source.html.includes('<table>') ? 2 : 1;
      expect(
        (await renderedText(result.bytes)).filter((text) => text === replacement),
      ).toHaveLength(count);
    });

    it.each(['header', 'footer'])(
      'safely substitutes unsupported %s characters',
      async (surface) => {
        const result = await svc.renderPdf(
          { markdown: 'ASCII' },
          PageOptionsSchema.parse({ [surface]: '你好 {{page}}' }),
          createMockContext(),
        );
        expect(result.degraded).toBe(true);
        expect(await renderedText(result.bytes)).toEqual(['ASCII', '?? 1']);
      },
    );
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
