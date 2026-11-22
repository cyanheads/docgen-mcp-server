/**
 * @fileoverview Interpolates the PDF tool's scalar template placeholders.
 * @module services/document/render-template
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const PLACEHOLDER = /\{\{\{[^{}]*(?:\}\}\}|\}{0,2})|\{\{[^{}]*(?:\}\}|\}?)/g;
// An empty segment addresses an own property named '' using the original dotted-path grammar.
const PATH = /^[\w.]+$/;
const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
} as const;

function lookup(data: Record<string, unknown>, path: string): unknown {
  let value: unknown = data;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Array interpolation preserves JavaScript's comma joining and empty null positions. */
function isScalarValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isScalarValue);
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** Interpolates HTML text with double braces and deliberate HTML fragments with triple braces. */
export function renderTemplate(
  template: string,
  data: Record<string, unknown>,
  ctx: Context,
): string {
  const reason = 'template_render_failed';
  const fail = (message: string, details: Record<string, string>): never => {
    throw validationError(message, { reason, ...details, ...ctx.recoveryFor(reason) });
  };

  return template.replace(PLACEHOLDER, (placeholder) => {
    const raw = placeholder.startsWith('{{{');
    const braces = raw ? 3 : 2;
    const path = placeholder.slice(braces, -braces).trim();
    if (!placeholder.endsWith('}'.repeat(braces)) || !PATH.test(path)) {
      const tag = placeholder.slice(braces).replace(/\}+$/, '').trim() || placeholder;
      fail(`Unsupported template tag "${tag}".`, { tag });
    }
    const value = lookup(data, path);
    if (value === undefined || value === null) {
      fail(`Template references "${path}" but it is missing from the data object.`, {
        missingKey: path,
      });
    }
    if (!isScalarValue(value)) {
      fail(
        `Template value "${path}" must be a string, number, boolean, or array of scalar values.`,
        { path },
      );
    }
    const text = String(value);
    return raw
      ? text
      : text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch as keyof typeof HTML_ENTITIES]);
  });
}
