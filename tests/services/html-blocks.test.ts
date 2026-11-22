/**
 * @fileoverview Conversion coverage for the lightweight HTML/markdown block model.
 * @module tests/services/html-blocks.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToBlocks, markdownToBlocks } from '@/services/document/html-blocks.js';

describe('markdownToBlocks', () => {
  it('does not degrade a fence solely because it has a language label', () => {
    expect(markdownToBlocks('\x60\x60\x60ts\n  text\n\x60\x60\x60').degraded).toBe(false);
  });

  it('renders inline text, autolinks, and tight and loose task items', () => {
    const result = markdownToBlocks(
      '# Release **2.0**\n\n*Italic* and `&copy;` with [a link](https://example.com), <https://example.com>, and \\*escaped\\*.\n\n- [x] Parent\n  - [ ] Child\n    - Grandchild\n\n- [ ] Loose',
    );
    expect(result.blocks).toMatchObject([
      { kind: 'heading', text: 'Release 2.0' },
      {
        kind: 'paragraph',
        text: 'Italic and &copy; with a link (https://example.com), https://example.com, and *escaped*.',
      },
      { kind: 'listItem', text: '[x] Parent', depth: 0 },
      { kind: 'listItem', text: '[ ] Child', depth: 1 },
      { kind: 'listItem', text: 'Grandchild', depth: 2 },
      { kind: 'listItem', text: '[ ] Loose', depth: 0 },
    ]);
    expect(result.degraded).toBe(false);
  });

  it('reports images under nested items and renders ordinary raw HTML', () => {
    expect(markdownToBlocks('- Parent\n  - ![alt](image.png)').degraded).toBe(true);
    const html = '<p>Hello <strong>world</strong>.</p>';
    expect(markdownToBlocks(html)).toEqual(htmlToBlocks(html));
  });

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
    expect(result.blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Heading' },
      {
        kind: 'paragraph',
        text: 'Paragraph with bold, a link (https://example.com), and .',
      },
      { kind: 'paragraph', text: 'Quoted text' },
      { kind: 'listItem', text: 'Third', ordered: true, index: 3, depth: 0, continuation: false },
      { kind: 'listItem', text: 'Fourth', ordered: true, index: 4, depth: 0, continuation: false },
      { kind: 'pre', text: 'const answer = 42;\n' },
      { kind: 'tableRow', cells: ['Name', 'Value'], header: true },
      { kind: 'tableRow', cells: ['alpha', '1'], header: false },
      { kind: 'rule' },
      { kind: 'paragraph', text: 'unsupported raw html' },
    ]);
  });

  it('keeps ordinary markdown and whitespace non-degraded', () => {
    expect(markdownToBlocks('\n\nPlain text\n').degraded).toBe(false);
    expect(markdownToBlocks('')).toEqual({ blocks: [], degraded: false });
  });
});

describe('htmlToBlocks', () => {
  it('prints link destinations inside preformatted text while preserving its spacing', () => {
    expect(
      htmlToBlocks('<pre>  <a href="https://example.com">Source</a>  end</pre>').blocks,
    ).toEqual([{ kind: 'pre', text: '  Source (https://example.com)  end' }]);
  });

  it('walks nested wrappers and keeps surrounding text and table rows in order', () => {
    expect(
      htmlToBlocks(
        'Before<section><article><h2>Title</h2><p>Intro</p><table><tr><th>A</th><th>B</th></tr><tr><td>one<br>two</td><td>three</td></tr></table></article></section>After',
      ),
    ).toEqual({
      blocks: [
        { kind: 'paragraph', text: 'Before' },
        { kind: 'heading', level: 2, text: 'Title' },
        { kind: 'paragraph', text: 'Intro' },
        { kind: 'tableRow', cells: ['A', 'B'], header: true },
        { kind: 'tableRow', cells: ['one\ntwo', 'three'], header: false },
        { kind: 'paragraph', text: 'After' },
      ],
      degraded: false,
    });
  });

  it('keeps text after nested lists on the original item and resumes numbering', () => {
    expect(
      htmlToBlocks(
        '<ol start="3"><li>First<ul><li>Child<ol start="7"><li>Grandchild</li></ol></li></ul>Continued</li><li>Next</li></ol>',
      ).blocks,
    ).toMatchObject([
      { kind: 'listItem', text: 'First', depth: 0, index: 3 },
      { kind: 'listItem', text: 'Child', depth: 1, ordered: false },
      { kind: 'listItem', text: 'Grandchild', depth: 2, index: 7 },
      { kind: 'listItem', text: 'Continued', depth: 0, continuation: true },
      { kind: 'listItem', text: 'Next', depth: 0, index: 4 },
    ]);
  });

  it('detects unquoted style classes and styles in the head', () => {
    expect(
      htmlToBlocks(
        '<html><head><style>p { color: blue }</style></head><body>Visible</body></html>',
      ),
    ).toEqual({ blocks: [{ kind: 'paragraph', text: 'Visible' }], degraded: true });
    expect(htmlToBlocks('<p class=report>Visible</p>').degraded).toBe(true);
  });

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
      { kind: 'paragraph', text: 'A < B\u00a0> C' },
      { kind: 'paragraph', text: 'Quoted text' },
      { kind: 'listItem', text: 'First', ordered: false, index: 0, depth: 0, continuation: false },
      { kind: 'rule' },
      { kind: 'spacer' },
      { kind: 'tableRow', cells: ['Name', 'Value'], header: true },
      { kind: 'tableRow', cells: ['alpha', '1'], header: false },
    ]);
  });

  it('collects unwrapped text into a paragraph without adding spaces at inline boundaries', () => {
    expect(htmlToBlocks('Plain &quot;text&quot; with <em>emphasis</em>.')).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Plain "text" with emphasis.' }],
      degraded: false,
    });
  });

  it('drops empty supported elements without inventing blocks', () => {
    expect(htmlToBlocks('<p> </p><table><tr></tr></table>')).toEqual({
      blocks: [],
      degraded: false,
    });
  });

  it('decodes each character reference exactly once', () => {
    expect(htmlToBlocks('<p>&amp;lt;b&amp;gt; &amp;amp; &amp;#39;</p>').blocks).toEqual([
      { kind: 'paragraph', text: '&lt;b&gt; &amp; &#39;' },
    ]);
    expect(
      htmlToBlocks('<p>&lt;&gt;&quot;&#39;&apos;&#x27;&#169;&#x2014;&AMP;x&nbsp;y</p>').blocks,
    ).toEqual([{ kind: 'paragraph', text: `<>"'''©—&x\u00a0y` }]);
  });

  it('preserves unknown references and applies HTML numeric-reference replacements', () => {
    expect(
      htmlToBlocks('<p>&copy; &constructor; &__proto__; &#0; &#xD800; &#x110000;</p>').blocks,
    ).toEqual([{ kind: 'paragraph', text: '© &constructor; &__proto__; � � �' }]);
  });

  it('strips script, style, head, and comment regions whose closers carry whitespace', () => {
    const blocks = htmlToBlocks(
      "<p>Before</p><script>alert('x')</script ><SCRIPT>leak()</SCRIPT\n><style>p{color:red}</style\t><script>x()</script data-x><p>After</p>",
    );
    expect(blocks).toEqual({
      blocks: [
        { kind: 'paragraph', text: 'Before' },
        { kind: 'paragraph', text: 'After' },
      ],
      degraded: true,
    });

    expect(
      htmlToBlocks(
        '<head><title>Title</title></head >Body <script>hidden()</script > text<!-- a > b --!>',
      ),
    ).toEqual({ blocks: [{ kind: 'paragraph', text: 'Body text' }], degraded: true });
  });

  it('uses the parsed tree without reassembling or interpreting malformed tag text', () => {
    const result = htmlToBlocks('<p>Before <scr<script>x()</script>ipt>leak()</script> After</p>');
    expect(result).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Before x()ipt>leak() After' }],
      degraded: false,
    });
  });

  it('omits the parsed comment while preserving the following text', () => {
    const result = htmlToBlocks('<p>Shown <!-<!-- z -->- X>LEAK --> more</p>');
    expect(result).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Shown - X>LEAK --> more' }],
      degraded: false,
    });
  });
});

describe('markdownToBlocks character references', () => {
  it('decodes an escaped entity in markdown text once', () => {
    expect(markdownToBlocks('Literal &amp;lt;tag&amp;gt;').blocks).toEqual([
      { kind: 'paragraph', text: 'Literal &lt;tag&gt;' },
    ]);
  });
});
