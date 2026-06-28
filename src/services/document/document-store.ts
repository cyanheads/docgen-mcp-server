/**
 * @fileoverview DocumentStore service — persists rendered artifacts and their
 * metadata, mints opaque document ids, enforces TTL, and resolves ids back to
 * bytes + metadata. Wraps tenant-scoped `ctx.state` for both the lightweight meta
 * record and the base64 blob so a leaked id never crosses the tenant boundary.
 * @module services/document/document-store
 */

import { randomBytes } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import type { DocumentEnvelope, RenderResult, StoredDocumentMeta } from './types.js';

// Storage keys allow only alphanumerics, hyphens, underscores, dots, and
// slashes — no colons — so the namespace uses `/` separators.
const META_PREFIX = 'doc/meta/';
const BLOB_PREFIX = 'doc/blob/';
const ID_PREFIX = 'doc_';
const ID_BYTES = 18; // 18 bytes → 24 base64url chars

/**
 * Canonical shape of a minted document id: the `doc_` prefix plus exactly 24
 * url-safe base64url characters (18 random bytes → 24 chars). Must stay in lockstep
 * with `mintDocumentId`. Exported so the tool/resource input schemas reject a
 * malformed id at parse time, before it is ever interpolated into a storage key.
 */
export const DOCUMENT_ID_PATTERN = /^doc_[A-Za-z0-9_-]{24}$/;

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
    // Defence in depth: a malformed id can never match a minted one, so resolve it
    // as not-found before it reaches storage. The input schemas already reject these
    // at parse time; this guard ensures a missed boundary never constructs — or
    // leaks — an internal storage key.
    if (!DOCUMENT_ID_PATTERN.test(documentId)) return null;

    const meta = await ctx.state.get<StoredDocumentMeta>(`${META_PREFIX}${documentId}`);
    if (!meta) return null;

    const base64 = await ctx.state.get<string>(meta.blobKey);
    if (!base64) return null;

    return { meta, bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
  }

  /**
   * Builds the `DocumentEnvelope` from a stored meta record and the bytes. Inlines
   * the base64 only when the artifact is at or under the inline ceiling. Bytes are
   * delivered via the `resourceUri` (and inline base64 when small); `downloadUrl`
   * is reserved for a future HTTP download route and is not emitted in v1.
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

    if (meta.byteSize <= inlineMaxBytes) {
      envelope.inlineBase64 = Buffer.from(bytes).toString('base64');
    }

    ctx.log.debug('Built document envelope', {
      documentId: meta.documentId,
      inlined: envelope.inlineBase64 !== undefined,
    });

    return envelope;
  }
}

// --- Init/accessor pattern ---

let _store: DocumentStore | undefined;

export function initDocumentStore(): void {
  _store = new DocumentStore();
}

export function getDocumentStore(): DocumentStore {
  if (!_store) {
    throw new Error('DocumentStore not initialized — call initDocumentStore() in setup()');
  }
  return _store;
}
