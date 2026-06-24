/**
 * @fileoverview DocumentStore service — persists rendered artifacts and their
 * metadata, mints opaque document ids, enforces TTL, and resolves ids back to
 * bytes + metadata. Wraps tenant-scoped `ctx.state` for both the lightweight meta
 * record and the base64 blob so a leaked id never crosses the tenant boundary.
 * @module services/document/document-store
 */

import { randomBytes } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from '@/config/server-config.js';
import type { DocumentEnvelope, RenderResult, StoredDocumentMeta } from './types.js';

// Storage keys allow only alphanumerics, hyphens, underscores, dots, and
// slashes — no colons — so the namespace uses `/` separators.
const META_PREFIX = 'doc/meta/';
const BLOB_PREFIX = 'doc/blob/';
const ID_PREFIX = 'doc_';
const ID_BYTES = 18; // 18 bytes → 24 base64url chars

/**
 * Mints an opaque, non-guessable document id of the form `doc_` + 24 url-safe
 * characters. The id is the only handle into the store — it cannot be derived
 * from input.
 */
function mintDocumentId(): string {
  const token = randomBytes(ID_BYTES).toString('base64url');
  return `${ID_PREFIX}${token}`;
}

/** What a successful `get()` resolves to: the metadata plus the raw bytes. */
export interface ResolvedDocument {
  bytes: Uint8Array;
  meta: StoredDocumentMeta;
}

export class DocumentStore {
  constructor(private readonly config: AppConfig) {}

  /**
   * Persists rendered bytes + metadata under a freshly minted id, both written
   * with the configured document TTL so they expire together, and returns the
   * delivery envelope. Tenant scoping is handled by `ctx.state`.
   */
  async put(result: RenderResult, ctx: Context): Promise<DocumentEnvelope> {
    const { documentTtlSeconds } = getServerConfig();
    const documentId = mintDocumentId();
    const blobKey = `${BLOB_PREFIX}${documentId}`;
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + documentTtlSeconds * 1000;

    const meta: StoredDocumentMeta = {
      documentId,
      blobKey,
      mimeType: result.mimeType,
      byteSize: result.bytes.byteLength,
      ...(result.pageCount !== undefined && { pageCount: result.pageCount }),
      ...(result.sheetCount !== undefined && { sheetCount: result.sheetCount }),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAtMs,
    };

    const base64 = Buffer.from(result.bytes).toString('base64');

    // Write bytes then meta, both TTL-bounded. Meta is the authoritative record;
    // writing it last means a partial failure never surfaces a meta pointing at
    // absent bytes.
    await ctx.state.set(blobKey, base64, { ttl: documentTtlSeconds });
    await ctx.state.set(`${META_PREFIX}${documentId}`, meta, { ttl: documentTtlSeconds });

    ctx.log.info('Stored rendered document', {
      documentId,
      mimeType: meta.mimeType,
      byteSize: meta.byteSize,
      ttlSeconds: documentTtlSeconds,
    });

    return this.buildEnvelope(meta, result.bytes, ctx);
  }

  /**
   * Resolves a document id to its metadata and bytes, or `null` when the id is
   * unknown or its TTL has lapsed (both the meta record and the blob must be
   * present — a half-expired pair reads as gone).
   */
  async get(documentId: string, ctx: Context): Promise<ResolvedDocument | null> {
    const meta = await ctx.state.get<StoredDocumentMeta>(`${META_PREFIX}${documentId}`);
    if (!meta) return null;

    const base64 = await ctx.state.get<string>(meta.blobKey);
    if (!base64) return null;

    return { meta, bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
  }

  /**
   * Builds the `DocumentEnvelope` from a stored meta record and the bytes.
   * Inlines the base64 only when the artifact is at or under the inline ceiling;
   * derives a `downloadUrl` only when a public origin is configured (hosted mode).
   */
  buildEnvelope(meta: StoredDocumentMeta, bytes: Uint8Array, ctx: Context): DocumentEnvelope {
    const { inlineMaxBytes } = getServerConfig();
    const resourceUri = `docgen://document/${meta.documentId}`;
    const ttlSecondsRemaining = Math.max(0, Math.round((meta.expiresAtMs - Date.now()) / 1000));

    const envelope: DocumentEnvelope = {
      documentId: meta.documentId,
      resourceUri,
      mimeType: meta.mimeType,
      byteSize: meta.byteSize,
      ...(meta.pageCount !== undefined && { pageCount: meta.pageCount }),
      ...(meta.sheetCount !== undefined && { sheetCount: meta.sheetCount }),
      ttlSecondsRemaining,
      createdAt: meta.createdAt,
    };

    const downloadUrl = this.buildDownloadUrl(meta.documentId);
    if (downloadUrl) envelope.downloadUrl = downloadUrl;

    if (meta.byteSize <= inlineMaxBytes) {
      envelope.inlineBase64 = Buffer.from(bytes).toString('base64');
    }

    ctx.log.debug('Built document envelope', {
      documentId: meta.documentId,
      inlined: envelope.inlineBase64 !== undefined,
      hasDownloadUrl: downloadUrl !== undefined,
    });

    return envelope;
  }

  /**
   * Derives the absolute download URL from the configured public origin. Returns
   * `undefined` in stdio mode (no public origin), where delivery is inline/resource
   * only.
   */
  private buildDownloadUrl(documentId: string): string | undefined {
    const publicUrl = this.config.mcpPublicUrl;
    if (!publicUrl) return;
    const origin = publicUrl.replace(/\/+$/, '');
    return `${origin}/documents/${documentId}`;
  }
}

// --- Init/accessor pattern ---

let _store: DocumentStore | undefined;

export function initDocumentStore(config: AppConfig): void {
  _store = new DocumentStore(config);
}

export function getDocumentStore(): DocumentStore {
  if (!_store) {
    throw new Error('DocumentStore not initialized — call initDocumentStore() in setup()');
  }
  return _store;
}
