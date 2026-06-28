/**
 * @fileoverview End-to-end tool tests — drive the render/export/fill handlers and
 * docgen_get_document + the document resource, then DECODE the document delivered
 * through the tool output (inline base64 / resource blob) and assert valid magic
 * bytes. Confirms the bytes actually flow through the tool surface, not just the
 * service. Also covers the source-validation error contracts.
 * @module tests/tools/document-tools
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { documentResource } from '@/mcp-server/resources/definitions/document.resource.js';
import { exportSpreadsheetTool } from '@/mcp-server/tools/definitions/export-spreadsheet.tool.js';
import { fillFormTool } from '@/mcp-server/tools/definitions/fill-form.tool.js';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

const PDF_MAGIC = '%PDF-';
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

beforeEach(() => {
  resetServerConfig();
  vi.unstubAllEnvs();
  initRenderService();
  initDocumentStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetServerConfig();
});

describe('docgen_render_pdf', () => {
  it('returns an envelope whose inline base64 decodes to a valid PDF', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({
      source: { html: '<h1>Hello</h1><p>World</p>' },
      pageOptions: { size: 'A4', pageNumbers: true },
    });
    const result = await renderPdfTool.handler(input, ctx);

    const env = result.document;
    expect(env.mimeType).toBe('application/pdf');
    expect(env.pageCount).toBeGreaterThanOrEqual(1);
    expect(env.inlineBase64).toBeDefined();

    // The crucial assertion: decode the bytes delivered through the tool output.
    const bytes = decode(env.inlineBase64!);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe(PDF_MAGIC);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();

    const enrich = getEnrichment(ctx);
    expect(enrich.engine).toBe('lightweight');
    expect(enrich.degraded).toBe(false);
  });

  it('throws invalid_source when no source is provided', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({ source: {} });
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_source' },
    });
  });

  it('throws invalid_source when multiple sources are provided', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({ source: { html: '<p>a</p>', markdown: '# b' } });
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_source' },
    });
  });

  it('throws invalid_source when a template is given without a data object', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({ source: { template: '<p>{{x}}</p>' } });
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_source' },
    });
  });

  it('throws invalid_source when data is given with an html source (data would be ignored)', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({
      source: { html: '<p>html wins</p>', data: { unexpected: 'ignored' } },
    });
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_source' },
    });
  });

  it('throws invalid_source when data is given with a markdown source', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({ source: { markdown: '# md', data: { x: 1 } } });
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_source' },
    });
  });

  it('renders a template + data through the handler', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({
      source: { template: '<h1>{{title}}</h1><p>{{body}}</p>', data: { title: 'T', body: 'B' } },
    });
    const result = await renderPdfTool.handler(input, ctx);
    expect(result.document.mimeType).toBe('application/pdf');
    expect(result.document.inlineBase64).toBeDefined();
  });

  it('propagates template_render_failed with the contract recovery hint and missing key', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({
      source: { template: '<p>{{missing}}</p>', data: { present: '1' } },
    });
    // Regression: the throw now threads ctx so the declared recovery hint reaches the
    // wire (data.recovery.hint), alongside the still-useful missingKey.
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'template_render_failed',
        missingKey: 'missing',
        recovery: {
          hint: "Check the template's {{referenced}} fields against the keys present in the data object.",
        },
      },
    });
  });

  it('sets the degraded enrichment flag when styling is dropped', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({
      source: { html: '<style>.x{color:red}</style><p class="x">Styled</p>' },
    });
    await renderPdfTool.handler(input, ctx);
    const enrich = getEnrichment(ctx);
    expect(enrich.engine).toBe('lightweight');
    expect(enrich.degraded).toBe(true);
  });

  it('output conforms to the declared output schema', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({ source: { markdown: '# Hi' } });
    const result = await renderPdfTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(renderPdfTool.output));
  });

  it('throws document_too_large through the handler when the ceiling is tiny', async () => {
    vi.stubEnv('DOCGEN_MAX_DOCUMENT_BYTES', '1');
    resetServerConfig();
    const ctx = createMockContext({ tenantId: 't1', errors: renderPdfTool.errors });
    const input = renderPdfTool.input.parse({ source: { html: '<h1>Big</h1>' } });
    await expect(renderPdfTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'document_too_large' },
    });
  });
});

describe('docgen_export_spreadsheet', () => {
  it('returns an envelope whose inline base64 decodes to a valid xlsx', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: exportSpreadsheetTool.errors });
    const input = exportSpreadsheetTool.input.parse({
      sheets: [
        {
          name: 'Data',
          rows: [
            { a: 1, b: 'x' },
            { a: 2, b: 'y' },
          ],
        },
      ],
    });
    const result = await exportSpreadsheetTool.handler(input, ctx);

    const env = result.document;
    expect(env.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(env.sheetCount).toBe(1);
    expect(env.inlineBase64).toBeDefined();

    const bytes = decode(env.inlineBase64!);
    expect([...bytes.slice(0, 4)]).toEqual(XLSX_MAGIC);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(bytes));
    expect(wb.getWorksheet('Data')).toBeDefined();
  });

  it('throws empty_workbook when sheets is empty', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: exportSpreadsheetTool.errors });
    const input = exportSpreadsheetTool.input.parse({ sheets: [] });
    await expect(exportSpreadsheetTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_workbook' },
    });
  });

  it('throws invalid_sheet_name through the handler for an invalid worksheet name', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: exportSpreadsheetTool.errors });
    const input = exportSpreadsheetTool.input.parse({
      sheets: [{ name: 'Bad:Name', rows: [{ a: 1 }] }],
    });
    await expect(exportSpreadsheetTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_sheet_name' },
    });
  });
});

describe('docgen_fill_form', () => {
  async function makeFormBase64(): Promise<string> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    const form = pdf.getForm();
    form.createTextField('name').addToPage(page, { x: 20, y: 150, width: 200, height: 20 });
    return Buffer.from(await pdf.save()).toString('base64');
  }

  it('fills a base64 form and returns a decodable filled PDF + unmatchedFields', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const input = fillFormTool.input.parse({
      sourcePdf: { base64: await makeFormBase64() },
      fields: { name: 'Casey', bogus: 'x' },
      flatten: false,
    });
    const result = await fillFormTool.handler(input, ctx);

    expect(result.unmatchedFields).toEqual(['bogus']);
    const bytes = decode(result.document.inlineBase64!);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe(PDF_MAGIC);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getForm().getTextField('name').getText()).toBe('Casey');
  });

  it('accepts a line-wrapped base64 PDF (CLI / MIME-encoder output)', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    // Wrap at 40 chars with both LF and CRLF, as `base64`/MIME encoders do.
    const wrapped = (await makeFormBase64()).replace(/(.{40})/g, '$1\r\n');
    const input = fillFormTool.input.parse({
      sourcePdf: { base64: `\n${wrapped}\n` },
      fields: { name: 'Wrapped' },
    });
    const result = await fillFormTool.handler(input, ctx);
    const bytes = decode(result.document.inlineBase64!);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe(PDF_MAGIC);
    expect(await (await PDFDocument.load(bytes)).getForm().getTextField('name').getText()).toBe(
      'Wrapped',
    );
  });

  it('throws invalid_pdf_source for malformed base64', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const input = fillFormTool.input.parse({
      sourcePdf: { base64: 'not!valid!base64!!!' },
      fields: { a: 'b' },
    });
    await expect(fillFormTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_pdf_source' },
    });
  });

  it('throws invalid_source when both base64 and url are given', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const input = fillFormTool.input.parse({
      sourcePdf: { base64: await makeFormBase64(), url: 'https://example.com/f.pdf' },
      fields: { name: 'X' },
    });
    await expect(fillFormTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_source' },
    });
  });

  it('throws invalid_source when neither base64 nor url is given', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const input = fillFormTool.input.parse({ sourcePdf: {}, fields: { name: 'X' } });
    await expect(fillFormTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_source' },
    });
  });

  it('treats empty-string base64 and url as no source (form-client payload)', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    // Form clients submit the full shape with empty strings rather than omitting.
    const input = fillFormTool.input.parse({
      sourcePdf: { base64: '', url: '' },
      fields: { name: 'X' },
    });
    await expect(fillFormTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_source' },
    });
  });

  it('throws not_a_form through the handler for a flat PDF', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const plain = await PDFDocument.create();
    plain.addPage([200, 200]);
    const base64 = Buffer.from(await plain.save()).toString('base64');
    const input = fillFormTool.input.parse({ sourcePdf: { base64 }, fields: { a: 'b' } });
    await expect(fillFormTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_a_form' },
    });
  });

  it('fills a form fetched from a URL behind the SSRF guard (stubbed fetch)', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const formBytes = new Uint8Array(Buffer.from(await makeFormBase64(), 'base64'));
    const headers = new Headers({ 'content-type': 'application/pdf' });
    // Literal public-IP host → guard takes the isIP path, no DNS; fetch is stubbed.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(formBytes, { headers })));
    const input = fillFormTool.input.parse({
      sourcePdf: { url: 'https://93.184.216.34/form.pdf' },
      fields: { name: 'Fetched' },
    });
    const result = await fillFormTool.handler(input, ctx);
    const bytes = decode(result.document.inlineBase64!);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe(PDF_MAGIC);
    expect(await (await PDFDocument.load(bytes)).getForm().getTextField('name').getText()).toBe(
      'Fetched',
    );
  });

  it('throws source_unfetchable through the handler when the URL serves non-PDF', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: fillFormTool.errors });
    const headers = new Headers({ 'content-type': 'text/html' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html/>', { headers })));
    const input = fillFormTool.input.parse({
      sourcePdf: { url: 'https://93.184.216.34/not-a.pdf' },
      fields: { name: 'X' },
    });
    await expect(fillFormTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unfetchable' },
    });
  });
});

describe('docgen_get_document + resource', () => {
  // A mock context owns a private in-memory store, so the read path must reuse
  // the SAME context the write path used. Merge the error contracts so the one
  // ctx can `fail` with either tool's reasons.
  const mergedRenderGetErrors = [...renderPdfTool.errors, ...getDocumentTool.errors] as const;
  const mergedExportResourceErrors = [
    ...exportSpreadsheetTool.errors,
    ...documentResource.errors,
  ] as const;

  it('re-fetches a rendered document by id with the same envelope', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: mergedRenderGetErrors });
    const rendered = await renderPdfTool.handler(
      renderPdfTool.input.parse({ source: { markdown: '# Title' } }),
      ctx,
    );
    const id = rendered.document.documentId;

    const fetched = await getDocumentTool.handler(
      getDocumentTool.input.parse({ documentId: id }),
      ctx,
    );
    expect(fetched.document.documentId).toBe(id);
    expect(fetched.document.mimeType).toBe('application/pdf');
    const bytes = decode(fetched.document.inlineBase64!);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe(PDF_MAGIC);
  });

  it('throws document_expired for an unknown id', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: getDocumentTool.errors });
    await expect(
      getDocumentTool.handler(
        getDocumentTool.input.parse({ documentId: 'doc_unknownIdNotInTheStore01' }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'document_expired' },
    });
  });

  it('the resource throws document_expired for an unknown id', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: documentResource.errors });
    const uri = new URL('docgen://document/doc_missingIdNotInTheStore01');
    await expect(
      documentResource.handler({ documentId: 'doc_missingIdNotInTheStore01' }, { ...ctx, uri }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'document_expired' },
    });
  });

  it('does not resolve a document id minted for a different tenant', async () => {
    const ctxA = createMockContext({ tenantId: 'tenant-a', errors: renderPdfTool.errors });
    const rendered = await renderPdfTool.handler(
      renderPdfTool.input.parse({ source: { markdown: '# A' } }),
      ctxA,
    );
    const id = rendered.document.documentId;
    // A fresh context for a different tenant must see the id as expired/unknown.
    const ctxB = createMockContext({ tenantId: 'tenant-b', errors: getDocumentTool.errors });
    await expect(
      getDocumentTool.handler(getDocumentTool.input.parse({ documentId: id }), ctxB),
    ).rejects.toMatchObject({ data: { reason: 'document_expired' } });
  });

  it('the resource yields a blob content item carrying the document bytes', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: mergedExportResourceErrors });
    const rendered = await exportSpreadsheetTool.handler(
      exportSpreadsheetTool.input.parse({ sheets: [{ name: 'S', rows: [{ x: 1 }] }] }),
      ctx,
    );
    const id = rendered.document.documentId;

    const uri = new URL(`docgen://document/${id}`);
    const data = await documentResource.handler({ documentId: id }, { ...ctx, uri });
    const contents = documentResource.format!(data, { uri, mimeType: 'application/octet-stream' });

    const blob = contents.find(
      (c): c is { uri: string; blob: string; mimeType: string } => 'blob' in c,
    );
    expect(blob).toBeDefined();
    expect(blob!.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect([...decode(blob!.blob).slice(0, 4)]).toEqual(XLSX_MAGIC);

    const meta = contents.find(
      (c): c is { uri: string; text: string; mimeType: string } => 'text' in c,
    );
    expect(meta).toBeDefined();
    expect(JSON.parse(meta!.text).documentId).toBe(id);
  });

  it('rejects a malformed documentId at the schema boundary', () => {
    // The input regex rejects a non-conforming id before the handler runs, so no
    // internal storage key is ever built from caller input. Benign wrong-shape ids
    // stand in for the class — no exploit string embedded.
    for (const bad of ['short', 'not-a-minted-id', 'doc_tooFewChars']) {
      let caught: unknown;
      try {
        getDocumentTool.input.parse({ documentId: bad });
      } catch (e) {
        caught = e;
      }
      expect(caught, `"${bad}" must be rejected`).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain('doc/meta');
    }
  });

  it('get_document resolves a malformed id to the public document_expired contract', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: getDocumentTool.errors });
    // Defence in depth past the schema: a malformed id reaching the handler resolves
    // via the store guard to document_expired — never a storage-key validation error.
    await expect(
      getDocumentTool.handler({ documentId: 'not-a-minted-id' }, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'document_expired' },
    });
  });

  it('the resource resolves a malformed id to the public document_expired contract', async () => {
    const ctx = createMockContext({ tenantId: 't1', errors: documentResource.errors });
    const uri = new URL('docgen://document/malformed');
    await expect(
      documentResource.handler({ documentId: 'not-a-minted-id' }, { ...ctx, uri }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'document_expired' },
    });
  });
});

/**
 * The four tools' `format()` functions are pure and need no ctx. Each must render
 * every delivery field the model acts on (id, resource URI, download/inline state)
 * into the content[] text — the markdown twin content[]-only clients receive.
 */
describe('tool format()', () => {
  const pdfEnvelope = {
    documentId: 'doc_AAAAAAAAAAAAAAAAAAAAAAAA',
    resourceUri: 'docgen://document/doc_AAAAAAAAAAAAAAAAAAAAAAAA',
    mimeType: 'application/pdf' as const,
    byteSize: 145_408,
    pageCount: 3,
    ttlSecondsRemaining: 900,
    createdAt: '2026-06-23T12:00:00.000Z',
    inlineBase64: 'JVBERi0=',
  };
  const xlsxEnvelope = {
    documentId: 'doc_BBBBBBBBBBBBBBBBBBBBBBBB',
    resourceUri: 'docgen://document/doc_BBBBBBBBBBBBBBBBBBBBBBBB',
    downloadUrl: 'https://docgen.example.com/documents/doc_BBBBBBBBBBBBBBBBBBBBBBBB',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const,
    byteSize: 20_480,
    sheetCount: 2,
    ttlSecondsRemaining: 600,
    createdAt: '2026-06-23T12:00:00.000Z',
  };

  it('render_pdf format renders the id, resource URI, and page count', () => {
    const blocks = renderPdfTool.format!({ document: pdfEnvelope });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('3-page PDF');
    expect(text).toContain(pdfEnvelope.documentId);
    expect(text).toContain(pdfEnvelope.resourceUri);
    // Inline base64 is how content[]-only clients receive the bytes — must be present.
    expect(text).toContain('JVBERi0=');
  });

  it('export_spreadsheet format renders the sheet count and download URL', () => {
    const blocks = exportSpreadsheetTool.format!({ document: xlsxEnvelope });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2-sheet workbook');
    expect(text).toContain(xlsxEnvelope.downloadUrl);
    // Over the inline ceiling here (no inlineBase64) → the absence note must show.
    expect(text).toContain('omitted');
  });

  it('export_spreadsheet format notes the download URL is not emitted when absent', () => {
    const blocks = exportSpreadsheetTool.format!({
      document: { ...xlsxEnvelope, downloadUrl: undefined },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not emitted');
  });

  it('fill_form format lists unmatched fields when present', () => {
    const blocks = fillFormTool.format!({
      document: pdfEnvelope,
      unmatchedFields: ['ssn', 'dob'],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('ssn, dob');
    expect(text).toContain(pdfEnvelope.documentId);
  });

  it('fill_form format states none when every field matched', () => {
    const blocks = fillFormTool.format!({ document: pdfEnvelope, unmatchedFields: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('none — every field name matched');
  });

  it('get_document format labels a PDF vs a spreadsheet by mime type', () => {
    const pdf = (getDocumentTool.format!({ document: pdfEnvelope })[0] as { text: string }).text;
    expect(pdf).toContain('Retrieved PDF');
    const xlsx = (getDocumentTool.format!({ document: xlsxEnvelope })[0] as { text: string }).text;
    expect(xlsx).toContain('Retrieved spreadsheet');
  });
});
