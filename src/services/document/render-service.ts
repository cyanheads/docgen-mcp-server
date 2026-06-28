/**
 * @fileoverview RenderService — the bundled document rendering stack. Renders PDF
 * from HTML/markdown/template (lightweight pdf-lib engine), `.xlsx` from sheet
 * specs (exceljs), and fills/flattens AcroForm PDFs (pdf-lib). Enforces the byte
 * ceiling and a per-render timeout, and classifies render failures into the typed
 * reasons the write tools declare.
 * @module services/document/render-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams, timeout } from '@cyanheads/mcp-ts-core/errors';
import ExcelJS from 'exceljs';
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { getServerConfig } from '@/config/server-config.js';
import { fetchPdfGuarded } from './fetch-guard.js';
import { type BlockDocument, htmlToBlocks, markdownToBlocks } from './html-blocks.js';
import type { PageOptions, PdfSource, Sheet } from './render-types.js';
import { PDF_MIME, type RenderResult, XLSX_MIME } from './types.js';

/** Page dimensions in PostScript points (1pt = 1/72in), portrait orientation. */
const PAGE_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

const UNIT_TO_PT: Record<string, number> = { px: 0.75, pt: 1, mm: 2.83465, cm: 28.3465, in: 72 };
const DEFAULT_MARGIN_PT = 54; // 0.75in

/** Excel's worksheet-name limits — applied before any sheet is added to the workbook. */
const MAX_SHEET_NAME_LENGTH = 31;
const FORBIDDEN_SHEET_NAME_CHARS = /[*?:\\/[\]]/;

/** Parses a CSS length ("10mm", "0.5in") to points; falls back to the default. */
function lengthToPt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const m = value.match(/^([\d.]+)(px|pt|mm|cm|in)$/);
  if (!m) return fallback;
  return Number(m[1]) * (UNIT_TO_PT[m[2]!] ?? 1);
}

/** Result of a PDF render: the bytes plus the page count and degraded flag. */
interface PdfRenderOutput extends RenderResult {
  degraded: boolean;
}

export interface FillFormResult extends RenderResult {
  /** Field names supplied in the map that had no AcroForm counterpart. */
  unmatchedFields: string[];
}

export class RenderService {
  /**
   * Renders the PDF source (one of html / markdown / template+data) to a PDF
   * document. Returns the bytes, page count, and a `degraded` flag set when the
   * lightweight engine dropped unsupported styling. Validation of which source
   * key is present happens in the handler; this method trusts a resolved source.
   */
  renderPdf(source: PdfSource, pageOptions: PageOptions, ctx: Context): Promise<PdfRenderOutput> {
    const { renderTimeoutMs } = getServerConfig();
    return this.withTimeout(renderTimeoutMs, ctx, async () => {
      const doc = this.resolveSourceToBlocks(source, ctx);
      const out = await this.layoutPdf(doc, pageOptions, ctx);
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
   * flattens it, and returns the result plus any field names that had no match.
   * Throws `not_a_form` when the PDF has no fillable AcroForm fields.
   */
  fillForm(
    sourceBytes: Uint8Array,
    fields: Record<string, string | number | boolean>,
    flatten: boolean,
    ctx: Context,
  ): Promise<FillFormResult> {
    const { renderTimeoutMs } = getServerConfig();
    return this.withTimeout(renderTimeoutMs, ctx, async () => {
      let pdfDoc: PDFDocument;
      try {
        pdfDoc = await PDFDocument.load(sourceBytes);
      } catch {
        throw invalidParams('The source bytes are not a valid PDF document.', {
          reason: 'invalid_pdf_source',
          ...ctx.recoveryFor('invalid_pdf_source'),
        });
      }

      const form = pdfDoc.getForm();
      const formFields = form.getFields();
      if (formFields.length === 0) {
        throw invalidParams('The source PDF has no fillable AcroForm fields.', {
          reason: 'not_a_form',
          ...ctx.recoveryFor('not_a_form'),
        });
      }

      const available = new Set(formFields.map((f) => f.getName()));
      const unmatchedFields: string[] = [];

      for (const [name, value] of Object.entries(fields)) {
        if (!available.has(name)) {
          unmatchedFields.push(name);
          continue;
        }
        this.applyFieldValue(form, name, value);
      }

      if (flatten) form.flatten();

      const buffer = await pdfDoc.save();
      const bytes = new Uint8Array(buffer);
      this.assertWithinByteCeiling(bytes.byteLength, ctx);
      ctx.log.info('Filled form', {
        pageCount: pdfDoc.getPageCount(),
        filled: Object.keys(fields).length - unmatchedFields.length,
        unmatched: unmatchedFields.length,
        flattened: flatten,
      });
      return {
        bytes,
        mimeType: PDF_MIME,
        pageCount: pdfDoc.getPageCount(),
        unmatchedFields,
      };
    });
  }

  /**
   * Fetches a source PDF for form fill from a caller URL behind the SSRF guard.
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
    const filled = this.renderTemplate(source.template ?? '', source.data ?? {}, ctx);
    return htmlToBlocks(filled);
  }

  /**
   * Fills a `{{key}}` / `{{a.b}}` template from a data object. A referenced key
   * absent from `data` throws `template_render_failed` — the agent's signal to
   * reconcile the template against its data. `ctx` is threaded through so the throw
   * carries the declared recovery hint (`ctx.recoveryFor`) onto the wire, matching
   * the other typed failures in this service.
   */
  private renderTemplate(template: string, data: Record<string, unknown>, ctx: Context): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
      let value: unknown = data;
      for (const key of path.split('.')) {
        if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
          value = (value as Record<string, unknown>)[key];
        } else {
          value = undefined;
          break;
        }
      }
      if (value === undefined || value === null) {
        throw invalidParams(
          `Template references "${path}" but it is missing from the data object.`,
          {
            reason: 'template_render_failed',
            missingKey: path,
            ...ctx.recoveryFor('template_render_failed'),
          },
        );
      }
      return String(value);
    });
  }

  /** Lays the block model onto PDF pages, drawing top-to-bottom with wrapping. */
  private async layoutPdf(
    doc: BlockDocument,
    opts: PageOptions,
    ctx: Context,
  ): Promise<PdfRenderOutput> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const [pw, ph] = PAGE_SIZES[opts.size] ?? PAGE_SIZES.Letter!;
    const [pageW, pageH] = opts.orientation === 'landscape' ? [ph, pw] : [pw, ph];
    const mTop = lengthToPt(opts.margin?.top, DEFAULT_MARGIN_PT);
    const mRight = lengthToPt(opts.margin?.right, DEFAULT_MARGIN_PT);
    const mBottom = lengthToPt(opts.margin?.bottom, DEFAULT_MARGIN_PT);
    const mLeft = lengthToPt(opts.margin?.left, DEFAULT_MARGIN_PT);
    const contentW = pageW - mLeft - mRight;
    const reserveFooter = opts.pageNumbers || opts.footer ? 24 : 0;
    const reserveHeader = opts.header ? 24 : 0;

    const pages: PDFPage[] = [];
    let page = pdf.addPage([pageW, pageH]);
    pages.push(page);
    let y = pageH - mTop - reserveHeader;

    const newPage = () => {
      page = pdf.addPage([pageW, pageH]);
      pages.push(page);
      y = pageH - mTop - reserveHeader;
    };
    const ensure = (need: number) => {
      if (y - need < mBottom + reserveFooter) newPage();
    };

    const drawWrapped = (text: string, size: number, useFont: PDFFont, indent = 0): void => {
      const maxW = contentW - indent;
      for (const para of text.split('\n')) {
        const lines = wrapText(para, useFont, size, maxW);
        const lineHeight = size * 1.35;
        for (const line of lines) {
          ensure(lineHeight);
          page.drawText(line, {
            x: mLeft + indent,
            y: y - size,
            size,
            font: useFont,
            color: rgb(0.1, 0.1, 0.1),
          });
          y -= lineHeight;
        }
      }
    };

    for (const block of doc.blocks) {
      if (ctx.signal.aborted) break;
      switch (block.kind) {
        case 'heading': {
          const size = Math.max(12, 24 - (block.level - 1) * 3);
          y -= 6;
          drawWrapped(block.text, size, bold);
          y -= 2;
          break;
        }
        case 'paragraph':
          drawWrapped(block.text, 11, font);
          y -= 4;
          break;
        case 'listItem': {
          const marker = block.ordered ? `${block.index}.` : '•';
          ensure(11 * 1.35);
          page.drawText(marker, {
            x: mLeft + 6,
            y: y - 11,
            size: 11,
            font,
            color: rgb(0.1, 0.1, 0.1),
          });
          drawWrapped(block.text, 11, font, 22);
          break;
        }
        case 'tableRow': {
          const cellFont = block.header ? bold : font;
          const cols = block.cells.length || 1;
          const colW = contentW / cols;
          const rowLines = block.cells.map((c) => wrapText(c, cellFont, 10, colW - 8));
          const rowHeight = Math.max(1, ...rowLines.map((l) => l.length)) * (10 * 1.3) + 4;
          ensure(rowHeight);
          const rowTop = y;
          block.cells.forEach((_, i) => {
            const cx = mLeft + i * colW + 4;
            let cy = rowTop - 10;
            for (const line of rowLines[i] ?? []) {
              page.drawText(line, {
                x: cx,
                y: cy,
                size: 10,
                font: cellFont,
                color: rgb(0.1, 0.1, 0.1),
              });
              cy -= 10 * 1.3;
            }
          });
          y = rowTop - rowHeight;
          page.drawLine({
            start: { x: mLeft, y: y + 2 },
            end: { x: mLeft + contentW, y: y + 2 },
            thickness: 0.5,
            color: rgb(0.8, 0.8, 0.8),
          });
          break;
        }
        case 'rule':
          ensure(12);
          y -= 6;
          page.drawLine({
            start: { x: mLeft, y },
            end: { x: mLeft + contentW, y },
            thickness: 0.5,
            color: rgb(0.7, 0.7, 0.7),
          });
          y -= 6;
          break;
        case 'spacer':
          y -= 8;
          break;
      }
    }

    // Headers / footers / page numbers, interpolating the tokens per page.
    const total = pages.length;
    pages.forEach((p, i) => {
      const tokens = {
        page: String(i + 1),
        total: String(total),
        date: new Date().toISOString().slice(0, 10),
      };
      const interp = (tpl: string) =>
        tpl.replace(
          /\{\{\s*(page|total|date)\s*\}\}/g,
          (_m, k: 'page' | 'total' | 'date') => tokens[k],
        );
      if (opts.header) {
        p.drawText(interp(opts.header), {
          x: mLeft,
          y: pageH - mTop + 6,
          size: 9,
          font,
          color: rgb(0.4, 0.4, 0.4),
        });
      }
      const footerText = opts.footer
        ? interp(opts.footer)
        : opts.pageNumbers
          ? `Page ${i + 1} of ${total}`
          : undefined;
      if (footerText) {
        p.drawText(footerText, {
          x: mLeft,
          y: mBottom - 12,
          size: 9,
          font,
          color: rgb(0.4, 0.4, 0.4),
        });
      }
    });

    const buffer = await pdf.save();
    return {
      bytes: new Uint8Array(buffer),
      mimeType: PDF_MIME,
      pageCount: total,
      degraded: doc.degraded,
    };
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
        throw invalidParams(`Invalid worksheet name: ${problem}`, {
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
      const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
      return d && !Number.isNaN(d.getTime()) ? d : String(value);
    }
    if (type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isNaN(n) ? value : n;
    }
    if (type === 'boolean') return Boolean(value);
    return value;
  }

  /** Applies a value to a named AcroForm field, dispatching by field type. */
  private applyFieldValue(
    form: ReturnType<PDFDocument['getForm']>,
    name: string,
    value: string | number | boolean,
  ): void {
    const field = form.getField(name);
    const ctor = field.constructor.name;
    if (ctor === 'PDFCheckBox') {
      const cb = form.getCheckBox(name);
      if (value === true || value === 'true' || value === 'on' || value === 1 || value === '1')
        cb.check();
      else cb.uncheck();
      return;
    }
    if (ctor === 'PDFDropdown') {
      form.getDropdown(name).select(String(value));
      return;
    }
    if (ctor === 'PDFOptionList') {
      form.getOptionList(name).select(String(value));
      return;
    }
    if (ctor === 'PDFRadioGroup') {
      form.getRadioGroup(name).select(String(value));
      return;
    }
    // Default: text field.
    form.getTextField(name).setText(String(value));
  }

  /** Aborts a render whose artifact would exceed the configured byte ceiling. */
  private assertWithinByteCeiling(byteSize: number, ctx: Context): void {
    const { maxDocumentBytes } = getServerConfig();
    if (byteSize > maxDocumentBytes) {
      throw invalidParams(
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

/** Greedy word-wrap of a single paragraph to a max width in points. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const safe = sanitizeForFont(text);
  const words = safe.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      // If a single word is itself too wide, hard-break it character by character.
      if (!current && font.widthOfTextAtSize(word, size) > maxWidth) {
        for (const chunk of hardBreak(word, font, size, maxWidth)) lines.push(chunk);
        current = '';
        continue;
      }
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Breaks an overlong unbreakable token into width-bounded chunks. */
function hardBreak(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const ch of word) {
    if (font.widthOfTextAtSize(current + ch, size) > maxWidth && current) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Replaces characters the StandardFonts (WinAnsi) cannot encode so pdf-lib's
 * drawText never throws on exotic Unicode. Keeps the lightweight engine robust
 * against arbitrary caller content.
 */
function sanitizeForFont(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    switch (cp) {
      case 0x2018: // left single quote
      case 0x2019: // right single quote
        out += "'";
        break;
      case 0x201c: // left double quote
      case 0x201d: // right double quote
        out += '"';
        break;
      case 0x2013: // en dash
      case 0x2014: // em dash
        out += '-';
        break;
      case 0x2026: // ellipsis
        out += '...';
        break;
      case 0x2022: // bullet
        out += '*';
        break;
      default:
        // Keep printable Latin-1 (U+0020..U+00FF); drop everything else so
        // pdf-lib's WinAnsi StandardFonts never throw on exotic Unicode.
        out += cp >= 0x20 && cp <= 0xff ? ch : '?';
    }
  }
  return out;
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
