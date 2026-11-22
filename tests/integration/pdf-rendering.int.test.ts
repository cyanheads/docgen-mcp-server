/**
 * @fileoverview PDF byte delivery and degradation through the production-shaped MCP contract.
 * @module tests/integration/pdf-rendering.int.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { PDFDocument } from 'pdf-lib';
import { beforeEach, expect, it } from 'vitest';
import { renderPdfTool } from '@/mcp-server/tools/definitions/render-pdf.tool.js';
import { initDocumentStore } from '@/services/document/document-store.js';
import { initRenderService } from '@/services/document/render-service.js';

beforeEach(() => {
  initRenderService();
  initDocumentStore();
});

it.each([
  [{ markdown: '# Report **2.0**\n\n- [x] Parent\n  - [ ] Child' }, false],
  [{ markdown: '- Parent\n  - ![image](example.png)' }, true],
  [{ html: '<p>&#0;</p>' }, true],
  [{ html: '' }, false],
] as const)(
  'delivers the PDF and its degradation status in both results for %j',
  async (source, degraded) => {
    const result = await runToolContract(renderPdfTool, { source });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ degraded });
    const { document } = renderPdfTool.output.parse(result.structuredContent);
    const inline = document.inlineBase64;
    if (!inline) throw new Error('Missing inline PDF.');
    const lines = result.content.flatMap((block) =>
      block.type === 'text' ? block.text.split('\n') : [],
    );
    expect(lines).toContain(`**degraded:** ${degraded}`);
    expect(lines).toContain(`**Inline document (base64):** ${inline}`);
    const pdf = await PDFDocument.load(Buffer.from(inline, 'base64'));
    expect(pdf.getPageCount()).toBe(1);
  },
);
