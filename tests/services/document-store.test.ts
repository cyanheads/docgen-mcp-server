/**
 * @fileoverview DocumentStore tests — round-trip put/get over tenant-scoped state,
 * envelope construction (inline threshold, TTL countdown), tenant isolation, and
 * the get-document tool + resource retrieval paths.
 * @module tests/services/document-store
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { config } from '@cyanheads/mcp-ts-core/config';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { DocumentStore } from '@/services/document/document-store.js';
import { PDF_MIME, type RenderResult } from '@/services/document/types.js';

function pdfResult(bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3])): RenderResult {
  return { bytes, mimeType: PDF_MIME, pageCount: 1 };
}

describe('DocumentStore', () => {
  let store: DocumentStore;

  beforeEach(() => {
    resetServerConfig();
    vi.unstubAllEnvs();
    store = new DocumentStore(config);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('mints a doc_-prefixed id and round-trips bytes via get()', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const envelope = await store.put(pdfResult(), ctx);

    expect(envelope.documentId).toMatch(/^doc_[A-Za-z0-9_-]{24}$/);
    expect(envelope.resourceUri).toBe(`docgen://document/${envelope.documentId}`);
    expect(envelope.mimeType).toBe(PDF_MIME);
    expect(envelope.pageCount).toBe(1);
    expect(envelope.byteSize).toBe(8);
    expect(envelope.inlineBase64).toBeDefined();
    expect(envelope.ttlSecondsRemaining).toBeGreaterThan(0);

    const resolved = await store.get(envelope.documentId, ctx);
    expect(resolved).not.toBeNull();
    expect([...resolved!.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
    expect(resolved!.meta.documentId).toBe(envelope.documentId);
  });

  it('returns null for an unknown id', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    expect(await store.get('doc_doesnotexist000000000', ctx)).toBeNull();
  });

  it('writes only storage-key-safe keys (no colons — the real StorageService rejects them)', async () => {
    // Regression: the framework StorageService allows only alphanumerics, hyphens,
    // underscores, dots, and slashes in keys. A `doc:meta:` namespace passes the
    // mock state (no validation) but fails the live server. Assert the keys here.
    const ctx = createMockContext({ tenantId: 't1' });
    const writtenKeys: string[] = [];
    const realSet = ctx.state.set.bind(ctx.state);
    ctx.state.set = (key, value, opts) => {
      writtenKeys.push(key);
      return realSet(key, value, opts);
    };
    await store.put(pdfResult(), ctx);
    expect(writtenKeys.length).toBeGreaterThanOrEqual(2);
    const KEY_RE = /^[A-Za-z0-9._/-]+$/;
    for (const key of writtenKeys) {
      expect(key, `key "${key}" must be storage-safe`).toMatch(KEY_RE);
      expect(key).not.toContain(':');
    }
  });

  it('isolates documents per tenant — an id minted for t1 does not resolve for t2', async () => {
    const ctxA = createMockContext({ tenantId: 'tenant-a' });
    const ctxB = createMockContext({ tenantId: 'tenant-b' });
    const envelope = await store.put(pdfResult(), ctxA);
    // Same store instance, different tenant context: the id must not cross over.
    expect(await store.get(envelope.documentId, ctxB)).toBeNull();
    expect(await store.get(envelope.documentId, ctxA)).not.toBeNull();
  });

  it('omits inlineBase64 when the artifact exceeds the inline ceiling', async () => {
    vi.stubEnv('DOCGEN_INLINE_MAX_BYTES', '4');
    resetServerConfig();
    const ctx = createMockContext({ tenantId: 't1' });
    const big = pdfResult(new Uint8Array(10).fill(0x25));
    const envelope = await store.put(big, ctx);
    expect(envelope.byteSize).toBe(10);
    expect(envelope.inlineBase64).toBeUndefined();
  });

  it('omits downloadUrl in stdio mode (no public origin)', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const noUrl = await store.put(pdfResult(), ctx);
    expect(noUrl.downloadUrl).toBeUndefined();
  });

  it('derives a downloadUrl when a public origin is configured', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    // Construct the store with an explicit config carrying a public origin
    // (the global config proxy memoizes on first read, so stubbing env mid-run
    // is unreliable — pass the value directly).
    const hostedStore = new DocumentStore({
      mcpPublicUrl: 'https://docgen.example.com/',
    } as AppConfig);
    const hosted = await hostedStore.put(pdfResult(), ctx);
    expect(hosted.downloadUrl).toBe(`https://docgen.example.com/documents/${hosted.documentId}`);
  });

  it('strips trailing slashes from the public origin when building the URL', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const hostedStore = new DocumentStore({
      mcpPublicUrl: 'https://docgen.example.com///',
    } as AppConfig);
    const hosted = await hostedStore.put(pdfResult(), ctx);
    expect(hosted.downloadUrl).toBe(`https://docgen.example.com/documents/${hosted.documentId}`);
  });

  it('inlines an artifact exactly at the inline ceiling (boundary is inclusive)', async () => {
    vi.stubEnv('DOCGEN_INLINE_MAX_BYTES', '8');
    resetServerConfig();
    const ctx = createMockContext({ tenantId: 't1' });
    // pdfResult() default is exactly 8 bytes — byteSize <= ceiling must inline.
    const envelope = await store.put(pdfResult(), ctx);
    expect(envelope.byteSize).toBe(8);
    expect(envelope.inlineBase64).toBeDefined();
  });

  it('carries pageCount and omits sheetCount for a PDF result (and vice versa)', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const pdf = await store.put(
      { bytes: new Uint8Array([1, 2, 3]), mimeType: PDF_MIME, pageCount: 4 },
      ctx,
    );
    expect(pdf.pageCount).toBe(4);
    expect(pdf.sheetCount).toBeUndefined();

    const xlsx = await store.put(
      {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sheetCount: 2,
      },
      ctx,
    );
    expect(xlsx.sheetCount).toBe(2);
    expect(xlsx.pageCount).toBeUndefined();
  });

  it('reports ttlSecondsRemaining 0 (never negative) once the artifact has expired', async () => {
    // A 1-second TTL plus a clock advanced past it drives ttlSecondsRemaining to 0.
    vi.stubEnv('DOCGEN_DOCUMENT_TTL_SECONDS', '1');
    resetServerConfig();
    const ctx = createMockContext({ tenantId: 't1' });
    const envelope = await store.put(pdfResult(), ctx);

    // Rebuild the envelope from the stored meta with the clock moved past expiry.
    const resolved = await store.get(envelope.documentId, ctx);
    expect(resolved).not.toBeNull();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(resolved!.meta.expiresAtMs + 10_000);
    try {
      const rebuilt = store.buildEnvelope(resolved!.meta, resolved!.bytes, ctx);
      expect(rebuilt.ttlSecondsRemaining).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reads as gone when the blob is missing but the meta record survives', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const envelope = await store.put(pdfResult(), ctx);
    // Simulate the blob expiring/being evicted while the meta lingers.
    await ctx.state.delete(`doc/blob/${envelope.documentId}`);
    expect(await store.get(envelope.documentId, ctx)).toBeNull();
  });

  it('reads as gone when the meta record is missing but the blob survives', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    const envelope = await store.put(pdfResult(), ctx);
    await ctx.state.delete(`doc/meta/${envelope.documentId}`);
    expect(await store.get(envelope.documentId, ctx)).toBeNull();
  });
});
