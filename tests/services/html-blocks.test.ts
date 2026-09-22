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

  it('decodes each character reference exactly once', () => {
    expect(htmlToBlocks('<p>&amp;lt;b&amp;gt; &amp;amp; &amp;#39;</p>').blocks).toEqual([
      { kind: 'paragraph', text: '&lt;b&gt; &amp; &#39;' },
    ]);
    expect(
      htmlToBlocks('<p>&lt;&gt;&quot;&#39;&apos;&#x27;&#169;&#x2014;&AMP;x&nbsp;y</p>').blocks,
    ).toEqual([{ kind: 'paragraph', text: `<>"'''©—&x y` }]);
  });

  it('leaves unknown, prototype-named, and out-of-range references verbatim', () => {
    expect(
      htmlToBlocks('<p>&copy; &constructor; &__proto__; &#0; &#xD800; &#x110000;</p>').blocks,
    ).toEqual([
      { kind: 'paragraph', text: '&copy; &constructor; &__proto__; &#0; &#xD800; &#x110000;' },
    ]);
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

  it('does not let a reassembled <script> pair leak its content past one strip pass', () => {
    // Stripping the inner <script>x()</script> leaves "<scr" + "ipt>leak()</script>",
    // which reassembles into a second, genuine <script>leak()</script> pair. A
    // single-pass strip misses it and "leak()" survives as visible paragraph text.
    const result = htmlToBlocks('<p>Before <scr<script>x()</script>ipt>leak()</script> After</p>');
    expect(result.blocks).toEqual([{ kind: 'paragraph', text: 'Before After' }]);
    expect(result.degraded).toBe(true);
  });

  it('does not let a reassembled comment leak trailing content past one strip pass', () => {
    // Stripping the inner <!-- z --> leaves "<!-" + "- X>LEAK -->", which
    // reassembles into <!-- X>LEAK -->. A single-pass strip removes only up to
    // the embedded ">" (the tag-stripping regex stops at the first ">"), leaving
    // "LEAK -->" as visible text.
    const result = htmlToBlocks('<p>Shown <!-<!-- z -->- X>LEAK --> more</p>');
    expect(result.blocks).toEqual([{ kind: 'paragraph', text: 'Shown more' }]);
  });
});

describe('markdownToBlocks character references', () => {
  it('decodes an escaped entity in markdown text once', () => {
    expect(markdownToBlocks('Literal &amp;lt;tag&amp;gt;').blocks).toEqual([
      { kind: 'paragraph', text: 'Literal &lt;tag&gt;' },
    ]);
  });
});
