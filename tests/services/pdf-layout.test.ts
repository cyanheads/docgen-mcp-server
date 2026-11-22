/**
 * @fileoverview Verifies PDF layout through the production render tool and emitted text operators.
 * @module tests/services/pdf-layout
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, StandardFonts } from 'pdf-lib';
import { assert, beforeEach, expect, it } from 'vitest';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

beforeEach(() => {
  initDocumentStore();
  initRenderService();
});

type RenderInput = Parameters<typeof renderPdfTool.handler>[0];

async function render(
  html: string,
  pageOptions?: Partial<NonNullable<RenderInput['pageOptions']>>,
) {
  const result = await runToolContract(renderPdfTool, { source: { html }, pageOptions });
  expect(result.isError).not.toBe(true);
  const { document } = renderPdfTool.output.parse(result.structuredContent);
  const text = result.content.find((block) => block.type === 'text')?.text;
  expect(text?.split('\n')).toContain(`**Page count:** ${document.pageCount}`);
  assert(document.inlineBase64 !== undefined, 'PDF bytes should be inline for layout fixtures.');
  expect(text?.split('\n')).toContain(`**Inline document (base64):** ${document.inlineBase64}`);
  const pdf = await PDFDocument.load(Buffer.from(document.inlineBase64, 'base64'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const decoder = new TextDecoder('windows-1252');
  const pages = pdf.getPages().map((page) => {
    const contents = page.node.Contents();
    if (!contents) return [];
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    return refs.flatMap((ref) => {
      const stream = pdf.context.lookup(ref);
      assert(stream instanceof PDFRawStream);
      const operators = Buffer.from(decodePDFRawStream(stream).decode()).toString();
      return Array.from(
        operators.matchAll(/1 0 0 1 (\S+) (\S+) Tm\n<([0-9A-F]*)> Tj/g),
        ([, x, y, hex]) => {
          assert(hex !== undefined, 'Expected a PDF text operand.');
          return { x: Number(x), y: Number(y), text: decoder.decode(Buffer.from(hex, 'hex')) };
        },
      );
    });
  });
  expect(document.pageCount).toBe(pages.length);
  return { font, pages };
}

it('preserves fitting decorations, ordinary table spacing and a decorated blank page', async () => {
  const decorations = { header: 'HDR {{page}}', footer: 'FTR {{page}}/{{total}}' };
  const { pages } = await render(
    '<table><tr><td>A</td><td>B</td></tr></table><p>C</p>',
    decorations,
  );
  expect(pages).toEqual([
    [
      { x: 58, y: 704, text: 'A' },
      { x: 310, y: 704, text: 'B' },
      { x: 54, y: 686, text: 'C' },
      { x: 54, y: 744, text: 'HDR 1' },
      { x: 54, y: 42, text: 'FTR 1/1' },
    ],
  ]);
  const blank = await render('', { ...decorations, margin: { top: '374pt', bottom: '370pt' } });
  expect(blank.pages).toEqual([
    [
      { x: 54, y: 424, text: 'HDR 1' },
      { x: 54, y: 358, text: 'FTR 1/1' },
    ],
  ]);
});

it('keeps a four-digit ordered marker clear of its item text', async () => {
  const { font, pages } = await render('<ol start="2026"><li>Report</li></ol>');
  const [marker, body] = pages[0] ?? [];
  assert(marker !== undefined && body !== undefined);
  expect(marker.text).toBe('2026.');
  expect(body.text).toBe('Report');
  expect(marker.y).toBe(body.y);
  expect(marker.x + font.widthOfTextAtSize(marker.text, 11)).toBeLessThan(body.x);
});

it('keeps whitespace-only text blocks blank with no room for a visible line', async () => {
  for (const html of [
    '<pre></pre>',
    '<pre>   </pre>',
    '<pre>\n\n</pre>',
    '<p><br></p>',
    '<h2><br></h2>',
  ]) {
    const { pages } = await render(html, { margin: { top: '791pt', bottom: '0pt' } });
    expect(pages).toEqual([[]]);
  }
});

it('wraps and reserves repeated decorations inside the page on every page', async () => {
  const header = 'FY 2026 quarterly financial report and business outlook - '.repeat(5);
  const footer = 'End of period financial report and accompanying notes - '.repeat(5);
  const html = Array.from({ length: 430 }, (_, i) => `<p>Body ${i + 1}</p>`).join('');
  const { font, pages } = await render(html, {
    header: `H{{page}}/{{total}} ${header}`,
    footer: `F{{page}}/{{total}} ${footer}`,
    margin: { top: '0pt', bottom: '0pt' },
  });
  expect(pages.length).toBeGreaterThan(9);
  expect(pages.flatMap((page) => page.filter(({ text }) => text.startsWith('Body ')))).toHaveLength(
    430,
  );
  for (const [i, page] of pages.entries()) {
    const body = page.filter(({ text }) => text.startsWith('Body '));
    const firstBody = body.at(0);
    const lastBody = body.at(-1);
    assert(firstBody && lastBody);
    const headerLines = page.filter(({ y }) => y > firstBody.y);
    const footerLines = page.filter(({ y }) => y < lastBody.y);
    expect(headerLines.length).toBeGreaterThan(1);
    expect(footerLines.length).toBeGreaterThan(1);
    expect(headerLines.map(({ text }) => text).join('')).toBe(
      `H${i + 1}/${pages.length} ${header}`,
    );
    expect(footerLines.map(({ text }) => text).join('')).toBe(
      `F${i + 1}/${pages.length} ${footer}`,
    );
    for (const line of [...headerLines, ...footerLines]) {
      expect(line.x).toBeGreaterThanOrEqual(0);
      expect(line.x + font.widthOfTextAtSize(line.text, 9)).toBeLessThanOrEqual(612.001);
      expect(line.y).toBeGreaterThanOrEqual(3);
      expect(line.y).toBeLessThanOrEqual(783);
    }
    const lastHeader = headerLines.at(-1);
    const firstFooter = footerLines.at(0);
    assert(lastHeader && firstFooter);
    expect(lastHeader.y - firstBody.y).toBeGreaterThan(11);
    expect(lastBody.y - firstFooter.y).toBeGreaterThan(11);
  }
});

it('repaginates the body when a two-digit page label makes the header wrap', async () => {
  const header = `H{{page}}/{{total}}${'W'.repeat(69)}`;
  const single = await render('<p>Body</p>', { header });
  const multi = await render('<p>Body</p>'.repeat(340), { header });
  expect(single.pages[0]).toHaveLength(2);
  expect(multi.pages).toHaveLength(10);
  expect(single.pages[0]?.[0]?.y).toBe(703);
  expect(multi.pages[0]?.[0]?.y).toBe(691);
  expect(multi.pages.at(-1)?.filter(({ text }) => text !== 'Body')).toHaveLength(2);
  expect(multi.pages.flat().filter(({ text }) => text === 'Body')).toHaveLength(340);
});

it('continues a tall table row across pages with synchronized columns', async () => {
  const left = Array.from({ length: 125 }, (_, i) => `Row cell body ${i + 1}`);
  const right = Array.from({ length: 70 }, (_, i) => `Second column ${i + 1}`);
  const cell = (lines: string[]) => `<td>${lines.map((line) => `<p>${line}</p>`).join('')}</td>`;
  const { pages } = await render(
    `<table><tr>${cell(left)}${cell(right)}</tr><tr><td>Next row</td></tr></table>`,
  );
  expect(pages).toHaveLength(3);
  expect(pages.flatMap((page) => page.filter(({ x }) => x === 58).map(({ text }) => text))).toEqual(
    [...left, 'Next row'],
  );
  expect(
    pages.flatMap((page) => page.filter(({ x }) => x === 310).map(({ text }) => text)),
  ).toEqual(right);
  for (const page of pages) {
    assert(page.length > 0);
    for (const row of page) {
      expect(row.y).toBeGreaterThanOrEqual(54);
      expect(row.y).toBeLessThanOrEqual(738);
      if (row.x === 310) {
        expect(
          page.find(({ text }) => text === `Row cell body ${row.text.split(' ').at(-1)}`)?.y,
        ).toBe(row.y);
      }
    }
  }
});

it('reports impossible decorations with the typed margin recovery on both surfaces', async () => {
  const result = await runToolContract(renderPdfTool, {
    source: { html: '' },
    pageOptions: { header: 'Wide report heading '.repeat(1200) },
  });
  const recovery =
    'Reduce the named margins, choose a larger page, or change the page orientation.';
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      error: { data: { reason: 'invalid_page_margins', recovery: { hint: recovery } } },
    },
  });
  const text = result.content.find((block) => block.type === 'text')?.text;
  expect(text).toContain('top and bottom');
  expect(text).toContain(recovery);
});
