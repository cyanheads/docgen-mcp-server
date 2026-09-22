/**
 * @fileoverview HTML/markdown → flat block model for the lightweight PDF engine.
 * The pdf-lib path cannot render arbitrary CSS, so it reduces a document to a
 * linear sequence of typed blocks (heading, paragraph, list item, table row,
 * rule) that the layout step draws top-to-bottom. Reports `degraded` when it
 * drops styling or structure (CSS, images, embedded markup) the engine can't
 * honor, so the caller can flag reduced fidelity.
 * @module services/document/html-blocks
 */

import { marked, type Token, type Tokens } from 'marked';

/** A single laid-out block in the linear document model. */
export type DocBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'listItem'; text: string; ordered: boolean; index: number }
  | { kind: 'tableRow'; cells: string[]; header: boolean }
  | { kind: 'rule' }
  | { kind: 'spacer' };

export interface BlockDocument {
  blocks: DocBlock[];
  /** True when the converter dropped styling/structure it cannot render faithfully. */
  degraded: boolean;
}

/** Named character references the converter decodes; any other name stays verbatim. */
const NAMED_ENTITIES = new Map([
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * Decodes one character reference. Numeric references outside the Unicode scalar
 * range (NUL, surrogates, past U+10FFFF) and unknown names are returned verbatim.
 */
function decodeReference(match: string, ref: string): string {
  if (ref[0] !== '#') return NAMED_ENTITIES.get(ref.toLowerCase()) ?? match;
  const codePoint = /^#x/i.test(ref) ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
  const valid =
    codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : match;
}

/**
 * Collapses whitespace and decodes character references in a single pass, so an
 * `&` produced by decoding `&amp;` is never read as the start of another reference.
 */
function normalizeText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeReference)
    .trim();
}

/** Strips any remaining inline tags from a fragment, returning plain text. */
function stripTags(html: string): string {
  return normalizeText(html.replace(/<[^>]+>/g, ' '));
}

/**
 * Converts a markdown string to the block model via marked's lexer. Inline
 * emphasis/links collapse to their text (the lightweight engine has one font),
 * which sets `degraded` only for genuinely unsupported constructs (images, raw
 * HTML blocks), not for ordinary bold/italic.
 */
export function markdownToBlocks(md: string): BlockDocument {
  const tokens = marked.lexer(md);
  const blocks: DocBlock[] = [];
  let degraded = false;

  const inline = (text: string): string => stripTags(text);

  /**
   * True when an inline-bearing token contains a markdown image, which the
   * lightweight engine cannot render (only the alt text survives). Mirrors the
   * HTML path's `<img>` detection so the markdown path degrades consistently.
   */
  const hasInlineImage = (token: Token): boolean =>
    'tokens' in token &&
    Array.isArray(token.tokens) &&
    token.tokens.some((t) => t.type === 'image');

  const walk = (toks: Token[]): void => {
    for (const token of toks) {
      if (hasInlineImage(token)) degraded = true;
      switch (token.type) {
        case 'heading':
          blocks.push({ kind: 'heading', level: token.depth, text: inline(token.text) });
          break;
        case 'paragraph':
          blocks.push({ kind: 'paragraph', text: inline(token.text) });
          break;
        case 'text': {
          const t = inline('text' in token ? String(token.text) : '');
          if (t) blocks.push({ kind: 'paragraph', text: t });
          break;
        }
        case 'blockquote':
          blocks.push({ kind: 'paragraph', text: inline(token.text) });
          break;
        case 'list': {
          token.items.forEach((item: Tokens.ListItem, i: number) => {
            blocks.push({
              kind: 'listItem',
              text: inline(item.text),
              ordered: Boolean(token.ordered),
              index: (typeof token.start === 'number' ? token.start : 1) + i,
            });
          });
          break;
        }
        case 'code':
          blocks.push({ kind: 'paragraph', text: token.text });
          break;
        case 'table': {
          const header = token.header.map((c: Tokens.TableCell) => inline(c.text));
          blocks.push({ kind: 'tableRow', cells: header, header: true });
          for (const row of token.rows) {
            blocks.push({
              kind: 'tableRow',
              cells: row.map((c: Tokens.TableCell) => inline(c.text)),
              header: false,
            });
          }
          break;
        }
        case 'hr':
          blocks.push({ kind: 'rule' });
          break;
        case 'space':
          break;
        case 'html':
          degraded = true;
          break;
        default:
          if ('text' in token && token.text) {
            blocks.push({ kind: 'paragraph', text: inline(String(token.text)) });
          }
      }
    }
  };

  walk(tokens);
  return { blocks, degraded };
}

const BLOCK_TAG_RE =
  /<(h[1-6]|p|li|tr|hr|blockquote|pre|div|section|article|header|footer|td|th)\b[^>]*>([\s\S]*?)<\/\1>|<(hr|br)\s*\/?\s*>/gi;

/**
 * Converts an HTML string to the block model with a deliberately small parser:
 * it pulls block-level elements (headings, paragraphs, list items, table rows,
 * rules) and reduces everything else to text. Real CSS, layout, fonts, images,
 * and scripts are NOT honored — their presence sets `degraded` so the caller can
 * surface the fidelity gap. There is no JS execution and no remote-resource fetch.
 */
export function htmlToBlocks(html: string): BlockDocument {
  const blocks: DocBlock[] = [];
  let degraded = false;

  // Strip non-rendered regions outright; their presence is not itself degradation.
  // Closers match the way an HTML parser reads them: an end tag may carry
  // whitespace or attributes (`</script >`), and a comment may close with `--!>`.
  let body = html.replace(/<!--[\s\S]*?--!?>/g, '');
  const headMatch = body.match(/<head\b[^>]*>([\s\S]*?)<\/head\b[^>]*>/i);
  if (headMatch) body = body.replace(headMatch[0], '');
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, () => {
    degraded = true;
    return '';
  });
  body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, () => {
    degraded = true;
    return '';
  });
  if (/\bstyle\s*=\s*["']/i.test(body) || /\bclass\s*=\s*["']/i.test(body)) degraded = true;
  if (/<img\b/i.test(body)) degraded = true;

  // Pull table rows as units so cells stay grouped.
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const rows: { index: number; length: number; row: { cells: string[]; header: boolean } }[] = [];
  for (const m of body.matchAll(rowRe)) {
    const inner = m[1] ?? '';
    const cells: string[] = [];
    let header = false;
    for (const c of inner.matchAll(cellRe)) {
      if ((c[1] ?? '').toLowerCase() === 'th') header = true;
      cells.push(stripTags(c[2] ?? ''));
    }
    if (cells.length > 0) {
      rows.push({ index: m.index ?? 0, length: m[0].length, row: { cells, header } });
    }
  }

  // Linearize the document: walk top-level block elements in document order,
  // splicing table rows in at their positions.
  const consumedRanges = rows.map((r) => [r.index, r.index + r.length] as const);
  const inConsumed = (pos: number) => consumedRanges.some(([s, e]) => pos >= s && pos < e);

  type Emit = { index: number; block: DocBlock };
  const emits: Emit[] = [];

  for (const m of body.matchAll(BLOCK_TAG_RE)) {
    const pos = m.index ?? 0;
    if (inConsumed(pos)) continue; // table cells handled separately
    const tag = (m[1] ?? m[3] ?? '').toLowerCase();
    const inner = m[2] ?? '';

    if (tag === 'hr' || tag === 'br') {
      emits.push({ index: pos, block: tag === 'hr' ? { kind: 'rule' } : { kind: 'spacer' } });
      continue;
    }
    if (tag === 'td' || tag === 'th' || tag === 'tr') continue;

    const text = stripTags(inner);
    if (!text) continue;

    if (/^h[1-6]$/.test(tag)) {
      emits.push({ index: pos, block: { kind: 'heading', level: Number(tag[1]), text } });
    } else if (tag === 'li') {
      emits.push({ index: pos, block: { kind: 'listItem', text, ordered: false, index: 0 } });
    } else {
      emits.push({ index: pos, block: { kind: 'paragraph', text } });
    }
  }

  for (const r of rows) {
    emits.push({
      index: r.index,
      block: { kind: 'tableRow', cells: r.row.cells, header: r.row.header },
    });
  }

  emits.sort((a, b) => a.index - b.index);
  for (const e of emits) blocks.push(e.block);

  // Fallback: a body with text but no recognized block tags becomes one paragraph
  // per line so plain-text or div-only HTML still renders something.
  if (blocks.length === 0) {
    const text = stripTags(body);
    if (text) {
      for (const line of text.split(/\n+/)) {
        const t = line.trim();
        if (t) blocks.push({ kind: 'paragraph', text: t });
      }
    }
  }

  return { blocks, degraded };
}
