/**
 * @fileoverview RenderService — the bundled document rendering stack. Renders PDF
 * from HTML/markdown/template (lightweight pdf-lib engine), `.xlsx` from sheet
 * specs (exceljs), and fills/flattens AcroForm PDFs (pdf-lib). Enforces the byte
 * ceiling and a per-render timeout, and classifies render failures into the typed
 * reasons the write tools declare.
 * @module services/document/render-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { timeout, validationError } from '@cyanheads/mcp-ts-core/errors';
import ExcelJS from 'exceljs';
import { PDFArray, PDFDocument, type PDFForm, PDFName, type PDFObject } from 'pdf-lib';
import { getServerConfig } from '@/config/server-config.js';
import { fetchPdfGuarded } from './fetch-guard.js';
import { applyFormAssignments, type FormAssignmentReport } from './form-assignments.js';
import { type FormFieldInfo, inventoryFormFields } from './form-inventory.js';
import { type BlockDocument, htmlToBlocks, markdownToBlocks } from './html-blocks.js';
import { layoutPdf, type PdfRenderOutput } from './pdf-layout.js';
import { renderTemplate } from './render-template.js';
import type { FormFields, PageOptions, PdfSource, Sheet } from './render-types.js';
import { PDF_MIME, type RenderResult, XLSX_MIME } from './types.js';

/** Excel's worksheet-name limits — applied before any sheet is added to the workbook. */
const MAX_SHEET_NAME_LENGTH = 31;
const FORBIDDEN_SHEET_NAME_CHARS = /[*?:\\/[\]]/;

/** Matches a full calendar date with an optional clock time and UTC offset. */
const SPREADSHEET_DATE =
  /^(\d{4}-\d{2}-\d{2})(?:T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?|24:00(?::00(?:\.0+)?)?)(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/i;

/** Uses a UTC calendar round trip to catch day overflow before applying offsets. */
function parseSpreadsheetDate(value: string): Date | undefined {
  const [, calendarDate, offset] = SPREADSHEET_DATE.exec(value) ?? [];
  if (calendarDate === undefined) return undefined;
  const midnight = new Date(calendarDate);
  if (Number.isNaN(midnight.getTime()) || !midnight.toISOString().startsWith(calendarDate)) {
    return undefined;
  }
  if (value === calendarDate) return midnight;
  return new Date(offset ? value : `${value}Z`);
}

/** Filled PDF bytes and assignment results. */
export interface FillFormResult extends RenderResult, FormAssignmentReport {}

/** Bakes the widget appearances and removes their entries from page annotation arrays. */
function flattenForm(form: PDFForm): void {
  // pdf-lib 1.17.1 removes annotation entries by appearance ref, then deletes the widget objects.
  const widgetEntries = new Set<PDFObject>();
  for (const field of form.getFields()) {
    const kids = field.acroField.Kids();
    if (kids) {
      for (let i = 0; i < kids.size(); i++) widgetEntries.add(kids.get(i));
    } else {
      // A terminal field without /Kids is also its own widget.
      widgetEntries.add(field.ref);
      widgetEntries.add(field.acroField.dict);
    }
  }
  form.flatten();
  if (widgetEntries.size === 0) return;

  for (const page of form.doc.getPages()) {
    const annotations = page.node.lookup(PDFName.Annots);
    if (!(annotations instanceof PDFArray)) continue;
    const count = annotations.size();
    let retained = 0;
    for (let i = 0; i < count; i++) {
      const entry = annotations.get(i);
      if (widgetEntries.has(entry)) continue;
      if (retained !== i) annotations.set(retained, entry);
      retained++;
    }
    // Compact once so mixed widget and non-widget entries do not incur repeated shifts.
    for (let i = count - 1; i >= retained; i--) annotations.remove(i);
  }
}

export class RenderService {
  /** Lists every supported AcroForm field without saving or storing the PDF. */
  listFormFields(sourceBytes: Uint8Array, ctx: Context): Promise<FormFieldInfo[]> {
    return this.withTimeout(getServerConfig().renderTimeoutMs, ctx, async () =>
      inventoryFormFields(await this.loadFormPdf(sourceBytes, ctx)),
    );
  }

  /** Loads a PDF and enforces the shared AcroForm-source rejection contract. */
  private async loadFormPdf(sourceBytes: Uint8Array, ctx: Context): Promise<PDFDocument> {
    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(sourceBytes);
    } catch {
      throw validationError('The source bytes are not a valid PDF document.', {
        reason: 'invalid_pdf_source',
        ...ctx.recoveryFor('invalid_pdf_source'),
      });
    }
    if (pdf.getForm().getFields().length === 0)
      throw validationError('The source PDF has no fillable AcroForm fields.', {
        reason: 'not_a_form',
        ...ctx.recoveryFor('not_a_form'),
      });
    return pdf;
  }
  /**
   * Renders the PDF source (one of html / markdown / template+data) to a PDF
   * document. Returns the bytes, page count, and a `degraded` flag set when the
   * lightweight engine dropped unsupported styling or replaced text characters. Validation of which source
   * key is present happens in the handler; this method trusts a resolved source.
   */
  renderPdf(source: PdfSource, pageOptions: PageOptions, ctx: Context): Promise<PdfRenderOutput> {
    const { renderTimeoutMs } = getServerConfig();
    return this.withTimeout(renderTimeoutMs, ctx, async () => {
      const doc = this.resolveSourceToBlocks(source, ctx);
      const out = await layoutPdf(doc, pageOptions, ctx);
      this.assertWithinByteCeiling(out.bytes.byteLength, ctx);
      ctx.log.info('Rendered PDF', {
        pageCount: out.pageCount,
        byteSize: out.bytes.byteLength,
        degraded: out.degraded,
      });
      return out;
    });
  }

  /**
   * Renders one or more named sheets of row objects to an `.xlsx` workbook.
   * Applies the optional per-column spec (header, type, width, format). An empty
   * sheet produces a header-only worksheet; an empty `sheets[]` is rejected by the
   * handler before reaching here.
   */
  renderSpreadsheet(sheets: Sheet[], ctx: Context): Promise<RenderResult> {
    const { renderTimeoutMs } = getServerConfig();
    return this.withTimeout(renderTimeoutMs, ctx, async () => {
      this.assertValidSheetNames(sheets, ctx);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'docgen-mcp-server';
      workbook.created = new Date();

      for (const sheet of sheets) {
        const ws = workbook.addWorksheet(sheet.name);
        const columns = this.resolveColumns(sheet);
        ws.columns = columns.map((c) => ({
          header: c.header,
          key: c.key,
          ...(c.width !== undefined && { width: c.width }),
          ...(c.format !== undefined && { style: { numFmt: c.format } }),
        }));

        for (const row of sheet.rows) {
          const values: Record<string, ExcelJS.CellValue> = {};
          for (const col of columns) {
            values[col.key] = this.coerceCell(row[col.key] ?? null, col.type);
          }
          ws.addRow(values);
        }
        ws.getRow(1).font = { bold: true };
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer);
      this.assertWithinByteCeiling(bytes.byteLength, ctx);
      ctx.log.info('Rendered spreadsheet', {
        sheetCount: sheets.length,
        byteSize: bytes.byteLength,
      });
      return { bytes, mimeType: XLSX_MIME, sheetCount: sheets.length };
    });
  }

  /**
   * Loads a source PDF (base64 already decoded, or fetched behind the SSRF guard
   * by the handler), fills its AcroForm fields from the value map, optionally
   * flattens it, and returns the result and assignment report.
   * Rejects sources without AcroForm fields and invalid field assignments.
   */
  fillForm(
    sourceBytes: Uint8Array,
    fields: FormFields,
    flatten: boolean,
    ctx: Context,
  ): Promise<FillFormResult> {
    const { renderTimeoutMs } = getServerConfig();
    return this.withTimeout(renderTimeoutMs, ctx, async () => {
      const pdfDoc = await this.loadFormPdf(sourceBytes, ctx);
      const form = pdfDoc.getForm();
      const report = applyFormAssignments(form, fields, ctx);

      if (flatten) flattenForm(form);

      const buffer = await pdfDoc.save();
      const bytes = new Uint8Array(buffer);
      this.assertWithinByteCeiling(bytes.byteLength, ctx);
      ctx.log.info('Filled form', {
        pageCount: pdfDoc.getPageCount(),
        filled: Object.keys(fields).length - report.unmatchedFields.length,
        unmatched: report.unmatchedFields.length,
        flattened: flatten,
      });
      return {
        bytes,
        mimeType: PDF_MIME,
        pageCount: pdfDoc.getPageCount(),
        ...report,
      };
    });
  }

  /**
   * Fetches a source PDF for either form tool from a caller URL behind the SSRF guard.
   * Exposed on the service so the handler keeps a single code path; the byte cap
   * and timeout are enforced inside the guard.
   */
  fetchSourcePdf(url: string, ctx: Context): Promise<Uint8Array> {
    const { maxDocumentBytes, renderTimeoutMs } = getServerConfig();
    return fetchPdfGuarded(url, maxDocumentBytes, renderTimeoutMs, ctx);
  }

  // --- internals ---

  /** Resolves the source union to a block document, applying the template engine. */
  private resolveSourceToBlocks(source: PdfSource, ctx: Context): BlockDocument {
    if (source.html !== undefined) return htmlToBlocks(source.html);
    if (source.markdown !== undefined) return markdownToBlocks(source.markdown);
    // template path — handler validated template+data present before calling renderPdf.
    const filled = renderTemplate(source.template ?? '', source.data ?? {}, ctx);
    return htmlToBlocks(filled);
  }

  /**
   * Validates every worksheet name against Excel's constraints BEFORE any sheet is
   * created, so a bad name surfaces as the typed `invalid_sheet_name` reason rather
   * than a generic ExcelJS throw (forbidden character, duplicate) or a silent
   * over-31-character truncation. Uniqueness is case-insensitive, matching Excel.
   */
  private assertValidSheetNames(sheets: Sheet[], ctx: Context): void {
    const seen = new Set<string>();
    for (const { name } of sheets) {
      const problem = describeSheetNameProblem(name, seen);
      if (problem) {
        throw validationError(`Invalid worksheet name: ${problem}`, {
          reason: 'invalid_sheet_name',
          ...ctx.recoveryFor('invalid_sheet_name'),
        });
      }
    }
  }

  /** Resolves the effective column set for a sheet, deriving from row keys if absent. */
  private resolveColumns(
    sheet: Sheet,
  ): { key: string; header: string; type: string; width?: number; format?: string }[] {
    if (sheet.columns && sheet.columns.length > 0) {
      return sheet.columns.map((c) => ({
        key: c.key,
        header: c.header,
        type: c.type,
        ...(c.width !== undefined && { width: c.width }),
        ...(c.format !== undefined && { format: c.format }),
      }));
    }
    const keys = new Set<string>();
    for (const row of sheet.rows) for (const k of Object.keys(row)) keys.add(k);
    return [...keys].map((k) => ({ key: k, header: k, type: 'string' }));
  }

  /** Coerces a raw cell value to the exceljs value for the declared column type. */
  private coerceCell(value: string | number | boolean | null, type: string): ExcelJS.CellValue {
    if (value === null) return null;
    if (type === 'date') {
      if (typeof value !== 'string') return String(value);
      if (value.trim() === '') return null;
      return parseSpreadsheetDate(value) ?? value;
    }
    if (type === 'number') {
      if (typeof value === 'string' && value.trim() === '') return null;
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isNaN(n) ? value : n;
    }
    if (type === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      const normalized = value.trim().toLowerCase();
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      return value;
    }
    return value;
  }

  /** Aborts a render whose artifact would exceed the configured byte ceiling. */
  private assertWithinByteCeiling(byteSize: number, ctx: Context): void {
    const { maxDocumentBytes } = getServerConfig();
    if (byteSize > maxDocumentBytes) {
      throw validationError(
        `Rendered artifact is ${byteSize} bytes, over the ${maxDocumentBytes}-byte limit.`,
        { reason: 'document_too_large', ...ctx.recoveryFor('document_too_large') },
      );
    }
  }

  /**
   * Runs a render under a wall-clock budget. On timeout, throws `render_timeout`
   * (the abort propagates into pdf-lib/exceljs via the signal where supported).
   */
  private async withTimeout<T>(ms: number, ctx: Context, fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            timeout(`Render exceeded the ${ms}ms time budget.`, {
              reason: 'render_timeout',
              ...ctx.recoveryFor('render_timeout'),
            }),
          ),
        ms,
      );
    });
    try {
      return await Promise.race([fn(), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Returns a human description of the first Excel-constraint violation in a
 * worksheet name, or `null` when the name is valid. Mutates `seen` with the
 * lower-cased name so a later case-insensitive duplicate is caught.
 */
function describeSheetNameProblem(name: string, seen: Set<string>): string | null {
  if (name.trim().length === 0) return 'a name is blank — provide a non-empty tab label.';
  if (name.length > MAX_SHEET_NAME_LENGTH) {
    return `"${name}" is ${name.length} characters — Excel caps tab names at ${MAX_SHEET_NAME_LENGTH}.`;
  }
  const forbidden = name.match(FORBIDDEN_SHEET_NAME_CHARS);
  if (forbidden) {
    return `"${name}" contains "${forbidden[0]}" — Excel forbids * ? : \\ / [ ] in tab names.`;
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    return `"${name}" begins or ends with an apostrophe, which Excel forbids in tab names.`;
  }
  const key = name.toLowerCase();
  if (seen.has(key)) {
    return `"${name}" duplicates another sheet — names must be unique (case-insensitive).`;
  }
  seen.add(key);
  return null;
}

// --- Init/accessor pattern ---

let _service: RenderService | undefined;

export function initRenderService(): void {
  _service = new RenderService();
}

export function getRenderService(): RenderService {
  if (!_service) {
    throw new Error('RenderService not initialized — call initRenderService() in setup()');
  }
  return _service;
}
