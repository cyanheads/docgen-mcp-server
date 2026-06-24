/**
 * @fileoverview Shared markdown formatter for the DocumentEnvelope. All four tools
 * return the same envelope shape, so they render it identically — every envelope
 * field appears in the content[] text (satisfying format-parity and giving
 * content[]-only clients the full delivery payload, including the inline base64
 * which is how those clients receive the bytes).
 * @module services/document/format-envelope
 */

import type { DocumentEnvelope } from './types.js';

/**
 * Renders a one-paragraph human summary plus every DocumentEnvelope field as
 * labeled lines. `lead` is the action-specific opening sentence (e.g. "Rendered a
 * 3-page PDF (142 KB)."). Optional fields render an explicit absence note so the
 * field path is always present for the parity walk.
 */
export function formatEnvelopeLines(lead: string, d: DocumentEnvelope): string {
  const lines: string[] = [
    lead,
    `**Document ID:** ${d.documentId}`,
    `**Resource:** ${d.resourceUri}`,
    `**Download URL:** ${d.downloadUrl ?? '(hosted mode only — not available over stdio)'}`,
    `**Mime type:** ${d.mimeType}`,
    `**Size:** ${d.byteSize} bytes`,
    `**Page count:** ${d.pageCount ?? '(not a paged document)'}`,
    `**Sheet count:** ${d.sheetCount ?? '(not a spreadsheet)'}`,
    `**Expires in:** ${d.ttlSecondsRemaining}s`,
    `**Created:** ${d.createdAt}`,
    d.inlineBase64 !== undefined
      ? `**Inline document (base64):** ${d.inlineBase64}`
      : '**Inline document (base64):** (omitted — over the inline size limit; fetch via the resource URI or download URL)',
  ];
  return lines.join('\n');
}
