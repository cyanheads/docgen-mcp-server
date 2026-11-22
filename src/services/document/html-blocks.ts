/**
 * @fileoverview Reduces an inert HTML tree to the lightweight PDF engine's block model.
 * @module services/document/html-blocks
 */

import { marked } from 'marked';
import { type DefaultTreeAdapterTypes, parse } from 'parse5';

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

/** A single laid-out block in the linear document model. */
export type DocBlock =
  | { kind: 'heading'; level: number; text: string; depth?: number }
  | { kind: 'paragraph'; text: string }
  | { kind: 'pre'; text: string; depth?: number }
  | {
      kind: 'listItem';
      text: string;
      ordered: boolean;
      index: number;
      depth: number;
      continuation: boolean;
    }
  | { kind: 'tableRow'; cells: string[]; header: boolean; depth?: number }
  | { kind: 'rule' }
  | { kind: 'spacer' };

export interface BlockDocument {
  blocks: DocBlock[];
  /** True when the converter dropped styling or structure it cannot render faithfully. */
  degraded: boolean;
}

type ListItem = {
  depth: number;
  ordered: boolean;
  index: number;
  taskMarker: string;
  continuation: boolean;
};

type Boundary = 'block-end' | 'paragraph-end' | 'paragraph-start';

const CONTAINERS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'body',
  'caption',
  'figcaption',
  'figure',
  'footer',
  'header',
  'main',
  'nav',
  'p',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
]);
const OMITTED = new Set(['head', 'title', 'script', 'style', 'template', 'img']);
const HTML_WHITESPACE = /[\t\n\f\r ]+/g;

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node;
}

function attribute(node: Element, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name && attr.namespace === undefined)?.value;
}

function droppedPresentation(node: Element): boolean {
  if (node.tagName === 'img' || node.tagName === 'script' || node.tagName === 'style') return true;
  if (
    node.tagName === 'link' &&
    attribute(node, 'rel')?.toLowerCase().split(HTML_WHITESPACE).includes('stylesheet')
  ) {
    return true;
  }
  if (attribute(node, 'style') !== undefined) return true;
  const className = attribute(node, 'class');
  if (className === undefined) return false;
  /** Marked uses this class to label fenced code. The label adds no document styling. */
  return !(
    node.tagName === 'code' &&
    node.parentNode?.nodeName === 'pre' &&
    /^language-\S+$/.test(className)
  );
}

/** Collapse HTML source whitespace while preserving hard breaks inserted during the walk. */
function normalizeLine(text: string): string {
  return text.replace(HTML_WHITESPACE, ' ').replace(/^ | $/g, '');
}

function taskCheckbox(node: Element): boolean {
  return (
    node.tagName === 'input' &&
    attribute(node, 'type')?.toLowerCase() === 'checkbox' &&
    attribute(node, 'disabled') !== undefined
  );
}

function firstContent(children: ChildNode[]): ChildNode | undefined {
  return children.find(
    (node) => isElement(node) || ('value' in node && normalizeLine(node.value) !== ''),
  );
}

function taskMarker(node: Element): string {
  let first = firstContent(node.childNodes);
  if (first && isElement(first) && first.tagName === 'p') first = firstContent(first.childNodes);
  if (!first || !isElement(first) || !taskCheckbox(first)) return '';
  return attribute(first, 'checked') === undefined ? '[ ] ' : '[x] ';
}

/** Converts Markdown to HTML with the existing parser and renders it through the same walker. */
export function markdownToBlocks(md: string): BlockDocument {
  return htmlToBlocks(marked.parse(md, { async: false }));
}

/** Preserves text and block order without executing scripts or loading external resources. */
export function htmlToBlocks(html: string): BlockDocument {
  const document = parse(html);
  const blocks: DocBlock[] = [];
  let degraded = false;

  /** Check real attributes and discarded styles even when the HTML parser places them in head. */
  const pending = [...document.childNodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || !isElement(node)) continue;
    if (droppedPresentation(node)) {
      degraded = true;
      break;
    }
    for (const child of node.childNodes) pending.push(child);
  }

  function inline(nodes: ChildNode[]): string[] {
    const lines = [''];
    const pendingNodes = Array.from(nodes).reverse();
    let node = pendingNodes.pop();
    while (node) {
      if ('value' in node) {
        lines[lines.length - 1] += node.value;
      } else if (isElement(node) && !OMITTED.has(node.tagName)) {
        if (node.tagName === 'br') {
          lines.push('');
        } else if (node.tagName === 'a') {
          const childLines = inline(node.childNodes);
          const href = attribute(node, 'href');
          const label = childLines.map(normalizeLine).join(' ').trim();
          if (href && href !== label) {
            const suffix = label ? ` (${href})` : href;
            const tail = childLines.length - 1;
            const lastLine = childLines[tail] ?? '';
            const trailingSpace = /[\t\n\f\r ]*$/.exec(lastLine)?.[0] ?? '';
            childLines[tail] =
              lastLine.slice(0, lastLine.length - trailingSpace.length) + suffix + trailingSpace;
          }
          appendLines(lines, childLines);
        } else {
          pushChildren(pendingNodes, node);
        }
      }
      node = pendingNodes.pop();
    }
    return lines;
  }

  function walk(nodes: ChildNode[], out: DocBlock[], item?: ListItem): void {
    let lines = [''];
    let paragraph = false;
    const emitItem = (text: string, listItem: ListItem): void => {
      const { depth, index, ordered, continuation } = listItem;
      out.push({
        kind: 'listItem',
        text: continuation ? text : `${listItem.taskMarker}${text}`.trimEnd(),
        depth,
        index,
        ordered,
        continuation,
      });
      listItem.continuation = true;
    };
    const flush = (): void => {
      const text = lines.map(normalizeLine).join('\n');
      lines = [''];
      if (!text) return;
      if (item) emitItem(text, item);
      else out.push({ kind: 'paragraph', text });
    };

    const pendingNodes: (ChildNode | Boundary)[] = Array.from(nodes).reverse();
    while (pendingNodes.length > 0) {
      const node = pendingNodes.pop();
      if (!node) continue;
      if (typeof node === 'string') {
        if (node === 'paragraph-start') paragraph = true;
        else {
          flush();
          if (node === 'paragraph-end') paragraph = false;
        }
        continue;
      }
      if ('value' in node) {
        lines[lines.length - 1] += node.value;
        continue;
      }
      if (!isElement(node) || OMITTED.has(node.tagName)) continue;
      const tag = node.tagName;
      if (tag === 'br') {
        if (paragraph || lines.length > 1 || normalizeLine(lines[0] ?? '')) lines.push('');
        else out.push({ kind: 'spacer' });
      } else if (tag === 'a') {
        appendLines(lines, inline([node]));
      } else if (tag === 'ol' || tag === 'ul') {
        flush();
        if (item && !item.continuation) emitItem('', item);
        const ordered = tag === 'ol';
        const start = attribute(node, 'start')?.match(/^[\t\n\f\r ]*[+-]?\d+/)?.[0];
        let index = ordered ? Number(start ?? 1) : 0;
        if (!Number.isSafeInteger(index)) index = 1;
        const depth = item ? item.depth + 1 : 0;
        for (const child of node.childNodes) {
          if (!isElement(child) || child.tagName !== 'li') continue;
          const listItem = {
            depth,
            index,
            ordered,
            taskMarker: taskMarker(child),
            continuation: false,
          };
          walk(child.childNodes, out, listItem);
          if (!listItem.continuation) emitItem('', listItem);
          if (ordered) index++;
        }
      } else if (tag === 'tr') {
        flush();
        const cells = node.childNodes.filter(
          (cell): cell is Element =>
            isElement(cell) && (cell.tagName === 'td' || cell.tagName === 'th'),
        );
        if (cells.length > 0) {
          if (item && !item.continuation) emitItem('', item);
          out.push({
            kind: 'tableRow',
            cells: cells.map((cell) => {
              const contents: DocBlock[] = [];
              walk(cell.childNodes, contents);
              return contents.map(blockText).join('\n');
            }),
            header: cells.some((cell) => cell.tagName === 'th'),
            ...(item && { depth: item.depth }),
          });
        }
      } else if (tag === 'pre') {
        flush();
        if (item && !item.continuation) emitItem('', item);
        const text = inline(node.childNodes).join('\n');
        out.push(item ? { kind: 'pre', text, depth: item.depth } : { kind: 'pre', text });
      } else if (tag === 'hr') {
        flush();
        if (item && !item.continuation) emitItem('', item);
        out.push({ kind: 'rule' });
      } else if (/^h[1-6]$/.test(tag)) {
        flush();
        if (item && !item.continuation) emitItem('', item);
        const text = inline(node.childNodes).map(normalizeLine).join('\n');
        if (text) {
          const level = Number(tag[1]);
          out.push(
            item
              ? { kind: 'heading', level, text, depth: item.depth }
              : { kind: 'heading', level, text },
          );
        }
      } else if (tag === 'li') {
        flush();
        const listItem = {
          depth: 0,
          ordered: false,
          index: 0,
          taskMarker: taskMarker(node),
          continuation: false,
        };
        walk(node.childNodes, out, listItem);
      } else if (CONTAINERS.has(tag)) {
        flush();
        pendingNodes.push(tag === 'p' ? 'paragraph-end' : 'block-end');
        pushChildren(pendingNodes, node);
        if (tag === 'p') pendingNodes.push('paragraph-start');
      } else {
        /** Inline elements are transparent. Sharing the buffer preserves punctuation and spacing. */
        pushChildren(pendingNodes, node);
      }
    }
    flush();
  }

  const root = document.childNodes.find(isElement);
  if (root) walk(root.childNodes, blocks);
  return { blocks, degraded };
}

function pushChildren(pendingNodes: (ChildNode | Boundary)[], node: Element): void {
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i];
    if (child) pendingNodes.push(child);
  }
}

function appendLines(lines: string[], text: string[]): void {
  const [first = '', ...rest] = text;
  lines[lines.length - 1] += first;
  for (const line of rest) lines.push(line);
}

/** Keeps nested cell content inside its parent row. */
function blockText(block: DocBlock): string {
  if ('text' in block) {
    if (block.kind !== 'listItem') return block.text;
    const marker = block.continuation ? '' : block.ordered ? `${block.index}. ` : '• ';
    return `${'  '.repeat(block.depth)}${marker}${block.text}`;
  }
  return block.kind === 'tableRow' ? block.cells.join(' ') : '';
}
