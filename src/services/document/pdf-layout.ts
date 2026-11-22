/**
 * @fileoverview Draws the shared HTML and Markdown block model as PDF pages.
 * @module services/document/pdf-layout
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import type { BlockDocument } from './html-blocks.js';
import type { PageOptions } from './render-types.js';
import { PDF_MIME, type RenderResult } from './types.js';

/** Page dimensions in PostScript points (1pt = 1/72in), portrait orientation. */
const PAGE_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
} satisfies Record<PageOptions['size'], readonly [number, number]>;

const UNIT_TO_PT = { px: 0.75, pt: 1, mm: 2.83465, cm: 28.3465, in: 72 } as const;
const DEFAULT_MARGIN_PT = 54; // 0.75in
const DECORATION_SIZE_PT = 9;
const DECORATION_LINE_HEIGHT_PT = 12;
const DECORATION_BAND_PT = 24;
const DECORATION_DESCENDER_PT = 3;
const DECORATION_WRAP_INSET_PT = 4;
const DECORATION_TOKEN = /\{\{\s*(page|total|date)\s*\}\}/g;
const PAGE_NUMBER_TOKEN = /\{\{\s*(page|total)\s*\}\}/;

/** Parses a CSS length ("10mm", "0.5in") to points; falls back to the default. */
function lengthToPt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const m = value.match(/^([\d.]+)(px|pt|mm|cm|in)$/);
  if (!m) return fallback;
  return Number(m[1]) * UNIT_TO_PT[m[2] as keyof typeof UNIT_TO_PT];
}

/** Result of a PDF render: the bytes plus the page count and degraded flag. */
export interface PdfRenderOutput extends RenderResult {
  degraded: boolean;
}

/** Lays the block model onto PDF pages, drawing top-to-bottom with wrapping. */
export function layoutPdf(
  doc: BlockDocument,
  opts: PageOptions,
  ctx: Context,
): Promise<PdfRenderOutput> {
  return renderPages(doc, opts, ctx, new Date().toISOString().slice(0, 10), 1);
}

async function renderPages(
  doc: BlockDocument,
  opts: PageOptions,
  ctx: Context,
  date: string,
  pageDigits: number,
): Promise<PdfRenderOutput> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let degraded = doc.degraded;
  const supported = new Set(font.getCharacterSet());
  const safeText = (text: string): string =>
    sanitizeForFont(text, supported, () => {
      degraded = true;
    });

  const [pw, ph] = PAGE_SIZES[opts.size];
  const [pageW, pageH] = opts.orientation === 'landscape' ? [ph, pw] : [pw, ph];
  const mTop = lengthToPt(opts.margin?.top, DEFAULT_MARGIN_PT);
  const mRight = lengthToPt(opts.margin?.right, DEFAULT_MARGIN_PT);
  const mBottom = lengthToPt(opts.margin?.bottom, DEFAULT_MARGIN_PT);
  const mLeft = lengthToPt(opts.margin?.left, DEFAULT_MARGIN_PT);
  const contentW = pageW - mLeft - mRight;
  const invalidMargins = (axis: 'height' | 'width'): never => {
    const reason = 'invalid_page_margins';
    const sides = axis === 'height' ? ['top', 'bottom'] : ['left', 'right'];
    throw validationError(
      `The ${sides.join(' and ')} margins leave too little ${axis} for the requested PDF layout.`,
      {
        reason,
        sides,
        ...ctx.recoveryFor(reason),
      },
    );
  };

  const requireWidth = (available: number, required: number) => {
    if (!(available > 0 && available >= required)) invalidMargins('width');
  };

  const pageNumberTemplate = opts.pageNumbers ? 'Page {{page}} of {{total}}' : undefined;
  const footerTemplate = opts.footer || pageNumberTemplate;
  const decorationWidth = (text: string) => font.widthOfTextAtSize(text, DECORATION_SIZE_PT);
  const decorationLines = (template: string, page: string, total: string): string[] => {
    const tokens = { page, total, date };
    const text = safeText(
      template.replace(DECORATION_TOKEN, (_match, token: keyof typeof tokens) => tokens[token]),
    );
    if (decorationWidth(text) <= pageW) return [text];
    return hardBreak(text, font, DECORATION_SIZE_PT, pageW - 2 * DECORATION_WRAP_INSET_PT);
  };
  const prepareDecoration = (template: string | undefined) => {
    if (template && PAGE_NUMBER_TOKEN.test(template)) {
      return (page: string, total: string) => decorationLines(template, page, total);
    }
    const lines = template ? decorationLines(template, '', '') : [];
    return () => lines;
  };
  const headerLines = prepareDecoration(opts.header);
  const footerLines = prepareDecoration(footerTemplate);
  const decorationSpan = (lineCount: number) =>
    Math.max(0, lineCount - 1) * DECORATION_LINE_HEIGHT_PT;
  const reservedBand = (lineCount: number) =>
    lineCount ? DECORATION_BAND_PT + decorationSpan(lineCount) : 0;
  // WinAnsi Helvetica has tabular digits. Reserve for the widest page and total labels.
  const pageSample = '8'.repeat(pageDigits);
  const headerSample = headerLines(pageSample, pageSample).length;
  const footerSample = footerLines(pageSample, pageSample).length;
  const bodyTop = pageH - mTop - reservedBand(headerSample);
  const bodyBottom = mBottom + reservedBand(footerSample);

  let page = pdf.addPage([pageW, pageH]);
  let y = bodyTop;

  const newPage = () => {
    page = pdf.addPage([pageW, pageH]);
    y = bodyTop;
  };
  const ensure = (need: number) => {
    if (!(bodyTop - bodyBottom >= need)) invalidMargins('height');
    if (y - bodyBottom < need) newPage();
  };

  const drawWrapped = (
    text: string,
    size: number,
    useFont: PDFFont,
    indent = 0,
    preserveWhitespace = false,
  ): void => {
    const maxW = contentW - indent;
    for (const para of text.split('\n')) {
      const lines = wrapText(safeText(para), useFont, size, maxW, preserveWhitespace);
      const lineHeight = size * 1.35;
      for (const line of lines) {
        if (line.trim()) requireWidth(maxW, useFont.widthOfTextAtSize(line, size));
        else if (bodyTop - bodyBottom < lineHeight) continue;
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

  /** Leave room to wrap item text even on narrow pages or deeply nested lists. */
  const listIndent = (depth: number): number => Math.min(depth * 18, contentW / 2);

  for (const block of doc.blocks) {
    if (ctx.signal.aborted) break;
    switch (block.kind) {
      case 'heading': {
        const size = Math.max(12, 24 - (block.level - 1) * 3);
        y -= 6;
        drawWrapped(
          block.text,
          size,
          bold,
          block.depth === undefined ? 0 : listIndent(block.depth) + 22,
        );
        y -= 2;
        break;
      }
      case 'paragraph':
        drawWrapped(block.text, 11, font);
        y -= 4;
        break;
      case 'pre':
        if (block.text === '') break;
        drawWrapped(
          block.text,
          11,
          font,
          block.depth === undefined ? 0 : listIndent(block.depth) + 22,
          true,
        );
        y -= 4;
        break;
      case 'listItem': {
        const indent = listIndent(block.depth);
        const marker = block.ordered ? `${block.index}.` : '•';
        const markerWidth = font.widthOfTextAtSize(marker, 11);
        if (!block.continuation) {
          requireWidth(contentW - indent - 6, markerWidth);
          ensure(11 * 1.35);
          page.drawText(marker, {
            x: mLeft + indent + 6,
            y: y - 11,
            size: 11,
            font,
            color: rgb(0.1, 0.1, 0.1),
          });
        }
        drawWrapped(block.text, 11, font, indent + Math.max(22, markerWidth + 10));
        break;
      }
      case 'tableRow': {
        const cellFont = block.header ? bold : font;
        const size = 10;
        const lineHeight = 13;
        const padding = 4;
        const cols = block.cells.length || 1;
        const indent = block.depth === undefined ? 0 : listIndent(block.depth) + 22;
        const colW = (contentW - indent) / cols;
        const rowLines = block.cells.map((c) =>
          c.split('\n').flatMap((line) => {
            const preserveWhitespace = /^ | $| {2}|\t/.test(line);
            return wrapText(safeText(line), cellFont, size, colW - 2 * padding, preserveWhitespace);
          }),
        );
        const lineCount = Math.max(1, ...rowLines.map((l) => l.length));
        const rowHeight = lineCount * lineHeight + padding;
        requireWidth(contentW, 0);
        // Test the full body box here. Narrow cells in an otherwise usable table
        // are a column-layout constraint, rather than an invalid page margin.
        for (const cell of rowLines) {
          for (const line of cell) {
            if (line) requireWidth(contentW - 2 * padding, cellFont.widthOfTextAtSize(line, size));
          }
        }
        const minimum = lineHeight + padding;
        // Keep ordinary rows whole. Oversized rows continue at the same line offset in every cell.
        ensure(rowHeight <= bodyTop - bodyBottom ? rowHeight : minimum);
        for (let offset = 0; offset < lineCount; ) {
          const capacity = Math.floor((y - bodyBottom - padding) / lineHeight);
          const count = Math.min(lineCount - offset, capacity);
          rowLines.forEach((lines, i) => {
            const cx = mLeft + indent + i * colW + padding;
            lines.slice(offset, offset + count).forEach((line, index) => {
              page.drawText(line, {
                x: cx,
                y: y - size - index * lineHeight,
                size,
                font: cellFont,
                color: rgb(0.1, 0.1, 0.1),
              });
            });
          });
          y -= count * lineHeight + padding;
          page.drawLine({
            start: { x: mLeft + indent, y: y + 2 },
            end: { x: mLeft + contentW, y: y + 2 },
            thickness: 0.5,
            color: rgb(0.8, 0.8, 0.8),
          });
          offset += count;
          if (offset < lineCount) newPage();
        }
        break;
      }
      case 'rule':
        requireWidth(contentW, 0);
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
  const pages = pdf.getPages();
  const total = pages.length;
  const totalLabel = String(total);
  if ((opts.header || footerTemplate) && totalLabel.length > pageDigits) {
    const widestLabel = '8'.repeat(totalLabel.length);
    if (
      headerLines(widestLabel, widestLabel).length > headerSample ||
      footerLines(widestLabel, widestLabel).length > footerSample
    ) {
      return renderPages(doc, opts, ctx, date, totalLabel.length);
    }
  }
  const minBaseline = DECORATION_DESCENDER_PT;
  const maxBaseline = pageH - DECORATION_SIZE_PT;
  const spanAvailable = maxBaseline - minBaseline;
  const drawDecoration = (p: PDFPage, lines: string[], baseline: number) => {
    if (lines.length === 0) return;
    const inset = lines.length > 1 ? DECORATION_WRAP_INSET_PT : 0;
    const width = Math.max(...lines.map(decorationWidth));
    const x = Math.max(inset, Math.min(mLeft, pageW - inset - width));
    lines.forEach((text, index) => {
      p.drawText(text, {
        x,
        y: baseline - index * DECORATION_LINE_HEIGHT_PT,
        size: DECORATION_SIZE_PT,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    });
  };
  pages.forEach((p, i) => {
    const pageLabel = String(i + 1);
    const header = headerLines(pageLabel, totalLabel);
    const footer = footerLines(pageLabel, totalLabel);
    const headerSpan = decorationSpan(header.length);
    const footerSpan = decorationSpan(footer.length);
    if (headerSpan > spanAvailable || footerSpan > spanAvailable) invalidMargins('height');
    const headerY = Math.max(minBaseline + headerSpan, Math.min(pageH - mTop + 6, maxBaseline));
    const footerY = Math.max(
      minBaseline + footerSpan,
      Math.min(mBottom - 12 + footerSpan, maxBaseline),
    );
    if (
      header.length &&
      footer.length &&
      headerY - headerSpan - minBaseline < footerY + DECORATION_SIZE_PT
    ) {
      invalidMargins('height');
    }
    drawDecoration(p, header, headerY);
    drawDecoration(p, footer, footerY);
  });

  const buffer = await pdf.save();
  return {
    bytes: new Uint8Array(buffer),
    mimeType: PDF_MIME,
    pageCount: total,
    degraded,
  };
}

/** Greedy word-wrap of a single paragraph to a max width in points. */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  preserveWhitespace = false,
): string[] {
  if (!text) return [''];
  if (preserveWhitespace) return hardBreak(text, font, size, maxWidth);
  const words = text.split(/ +/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
    } else {
      for (const chunk of hardBreak(word, font, size, maxWidth)) lines.push(chunk);
      current = '';
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
function sanitizeForFont(text: string, supported: Set<number>, onReplacement: () => void): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
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
        if (supported.has(cp)) out += ch;
        else if (/\s/u.test(ch)) out += ' ';
        else {
          out += '?';
          onReplacement();
        }
    }
  }
  return out;
}
