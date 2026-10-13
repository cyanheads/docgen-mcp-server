/**
 * @fileoverview Resolves the shared base64-or-URL PDF source for form tools.
 * @module services/document/source-pdf
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getRenderService } from './render-service.js';
import type { SourcePdf } from './render-types.js';

/** Validates the source pair and decodes bytes or uses the guarded URL fetch. */
export async function resolveSourcePdf(source: SourcePdf, ctx: Context): Promise<Uint8Array> {
  const hasBase64 = source.base64 !== undefined && source.base64 !== '';
  const hasUrl = source.url !== undefined && source.url !== '';
  if (hasBase64 === hasUrl)
    throw validationError('Provide exactly one PDF source: base64 or url.', {
      reason: 'invalid_source',
      ...ctx.recoveryFor('invalid_source'),
    });
  if (!hasBase64) return await getRenderService().fetchSourcePdf(source.url as string, ctx);
  const cleaned = (source.base64 as string)
    .replace(/[ \t\n\r\f\v]+/g, '')
    .replace(/^data:application\/pdf;base64,/, '');
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned))
    throw validationError('The source is not valid base64.', {
      reason: 'invalid_pdf_source',
      ...ctx.recoveryFor('invalid_pdf_source'),
    });
  const bytes = new Uint8Array(Buffer.from(cleaned, 'base64'));
  if (bytes.byteLength === 0)
    throw validationError('The source PDF is empty.', {
      reason: 'invalid_pdf_source',
      ...ctx.recoveryFor('invalid_pdf_source'),
    });
  return bytes;
}
