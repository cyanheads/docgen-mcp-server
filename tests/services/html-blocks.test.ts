/**
 * @fileoverview Conversion coverage for the lightweight HTML/markdown block model.
 * @module tests/services/html-blocks.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToBlocks, markdownToBlocks } from '@/services/document/html-blocks.js';

describe('markdownToBlocks', () => {
  it('linearizes every supported block and flags unsupported inline content', () => {
    const result = markdownToBlocks(`# Heading

Paragraph with **bold**, [a link](https://example.com), and ![alt](image.png).

> Quoted text

3. Third
4. Fourth

\`\`\`ts
const answer = 42;
\`\`\`

| Name | Value |
| --- | --- |
| alpha | 1 |

---

<aside>unsupported raw html</aside>`);

    expect(result.degraded).toBe(true);
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        { kind: 'heading', level: 1, text: 'Heading' },
        {
          kind: 'paragraph',
          text: 'Paragraph with **bold**, [a link](https://example.com), and ![alt](image.png).',
        },
        { kind: 'paragraph', text: 'Quoted text' },
        { kind: 'listItem', text: 'Third', ordered: true, index: 3 },
        { kind: 'listItem', text: 'Fourth', ordered: true, index: 4 },
        { kind: 'paragraph', text: 'const answer = 42;' },
        { kind: 'tableRow', cells: ['Name', 'Value'], header: true },
        { kind: 'tableRow', cells: ['alpha', '1'], header: false },
        { kind: 'rule' },
      ]),
    );
  });

  it('keeps ordinary markdown and whitespace non-degraded', () => {
    expect(markdownToBlocks('\n\nPlain text\n').degraded).toBe(false);
    expect(markdownToBlocks('')).toEqual({ blocks: [], degraded: false });
  });
});

describe('htmlToBlocks', () => {
  it('preserves supported blocks in order and reports dropped presentation', () => {
    const result = htmlToBlocks(`<!doctype html>
      <html>
        <head><title>Ignored</title></head>
        <body class="document">
          <!-- ignored comment -->
          <style>p { color: red; }</style>
          <script>throw new Error('never runs')</script>
          <h2>Report &amp; Notes</h2>
          <p style="font-weight:bold">A &lt; B&nbsp;&gt; C</p>
          <blockquote>Quoted <strong>text</strong></blockquote>
          <ul><li>First</li></ul>
          <hr><br>
          <table>
            <tr><th>Name</th><th>Value</th></tr>
            <tr><td>alpha</td><td>1</td></tr>
          </table>
          <img src="ignored.png" alt="ignored">
        </body>
      </html>`);

    expect(result.degraded).toBe(true);
    expect(result.blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Report & Notes' },
      { kind: 'paragraph', text: 'A < B > C' },
      { kind: 'paragraph', text: 'Quoted text' },
      { kind: 'listItem', text: 'First', ordered: false, index: 0 },
      { kind: 'rule' },
      { kind: 'spacer' },
      { kind: 'tableRow', cells: ['Name', 'Value'], header: true },
      { kind: 'tableRow', cells: ['alpha', '1'], header: false },
    ]);
  });

  it('falls back to a paragraph for unwrapped or unrecognized text', () => {
    expect(htmlToBlocks('Plain &quot;text&quot; with <em>emphasis</em>.')).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Plain "text" with emphasis .' }],
      degraded: false,
    });
  });

  it('drops empty supported elements without inventing blocks', () => {
    expect(htmlToBlocks('<p> </p><table><tr></tr></table>')).toEqual({
      blocks: [],
      degraded: false,
    });
  });
});
