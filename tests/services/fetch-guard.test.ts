/**
 * @fileoverview SSRF guard tests — the isBlockedIp classifier (private, loopback,
 * link-local, metadata, IPv6 cases), the fetchPdfGuarded scheme/host gate, and the
 * response-validation surface (content-type, status, byte cap, redirect handling)
 * exercised against a stubbed global fetch so no real network is contacted.
 * @module tests/services/fetch-guard
 */

import { lookup } from 'node:dns/promises';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPdfGuarded, isBlockedIp } from '@/services/document/fetch-guard.js';

/** Keys an upstream HTTP error must never leak onto the client-facing error `data`. */
const LEAK_KEYS = [
  'statusCode',
  'statusText',
  'responseBody',
  'requestId',
  'operation',
  'retryAfter',
  'url',
] as const;

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

/** Builds a Response the stubbed fetch returns; `body` rides as a real stream. */
function pdfResponse(
  body: Uint8Array = PDF_BYTES,
  init: { status?: number; contentType?: string | null; contentLength?: string | null } = {},
): Response {
  const headers = new Headers();
  if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/pdf');
  if (init.contentLength != null) headers.set('content-length', init.contentLength);
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A 3xx redirect Response pointing at `location` (omit for the no-Location case). */
function redirectResponse(location: string | null, status = 302): Response {
  const headers = new Headers();
  if (location !== null) headers.set('location', location);
  return new Response(null, { status, headers });
}

describe('isBlockedIp', () => {
  it('blocks RFC 1918 private ranges', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('172.16.5.4')).toBe(true);
    expect(isBlockedIp('172.31.255.255')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
  });

  it('blocks loopback and link-local', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('169.254.1.1')).toBe(true);
  });

  it('blocks the cloud metadata endpoint (169.254.169.254)', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
  });

  it('blocks unspecified, CGNAT, and reserved ranges', () => {
    expect(isBlockedIp('0.0.0.0')).toBe(true);
    expect(isBlockedIp('100.64.0.1')).toBe(true);
    expect(isBlockedIp('240.0.0.1')).toBe(true);
  });

  it('blocks IPv6 loopback, link-local, and unique-local', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd12:3456::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 pointing at a private address', () => {
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedIp('::ffff:192.168.0.1')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('fails closed on unparseable input', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('999.999.999.999')).toBe(true);
  });
});

describe('fetchPdfGuarded', () => {
  it('rejects non-https schemes with source_unfetchable', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      fetchPdfGuarded('http://example.com/form.pdf', 1000, 1000, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects a literal private-IP host before any network call', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      fetchPdfGuarded('https://127.0.0.1/form.pdf', 1000, 1000, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects the metadata IP as a literal host', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(
      fetchPdfGuarded('https://169.254.169.254/latest/meta-data', 1000, 1000, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects a malformed URL', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    await expect(fetchPdfGuarded('not a url', 1000, 1000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });
});

/**
 * Response-validation and redirect surface. A literal public-IP host takes the
 * `isIP` fast path in the guard, so these never resolve DNS — `fetch` itself is
 * stubbed, so no socket is opened. The DNS-resolution branch is covered separately.
 */
describe('fetchPdfGuarded response handling (stubbed fetch)', () => {
  const PUBLIC = 'https://93.184.216.34/form.pdf';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns the bytes on a valid application/pdf response', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(pdfResponse(PDF_BYTES));
    const bytes = await fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx);
    expect([...bytes]).toEqual([...PDF_BYTES]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts a content-type with parameters (application/pdf; charset=...)', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(
      pdfResponse(PDF_BYTES, { contentType: 'application/pdf; charset=binary' }),
    );
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).resolves.toBeDefined();
  });

  it('rejects a non-PDF content-type before buffering the body', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(pdfResponse(PDF_BYTES, { contentType: 'text/html' }));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects a missing content-type', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(pdfResponse(PDF_BYTES, { contentType: null }));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects a non-2xx status', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(pdfResponse(PDF_BYTES, { status: 404 }));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects when the declared content-length exceeds the byte cap', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(pdfResponse(PDF_BYTES, { contentLength: '999999' }));
    await expect(fetchPdfGuarded(PUBLIC, 100, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects an over-cap streamed body when no content-length is declared', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    // 500 bytes streamed, cap 100, no content-length header → caught while reading.
    const big = new Uint8Array(500).fill(0x25);
    fetchMock.mockResolvedValueOnce(pdfResponse(big, { contentLength: null }));
    await expect(fetchPdfGuarded(PUBLIC, 100, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('follows a redirect to a public target and returns the final bytes', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock
      .mockResolvedValueOnce(redirectResponse('https://93.184.216.34/final.pdf'))
      .mockResolvedValueOnce(pdfResponse(PDF_BYTES));
    const bytes = await fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx);
    expect([...bytes]).toEqual([...PDF_BYTES]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks a redirect that points at a private IP (re-validates each hop)', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(redirectResponse('https://10.0.0.1/internal.pdf'));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
    // The second (private) hop must never be fetched — only the first call happened.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks a redirect to the cloud-metadata endpoint', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(redirectResponse('https://169.254.169.254/latest/meta-data'));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects a redirect with no Location header', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockResolvedValueOnce(redirectResponse(null));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });

  it('rejects after exceeding the redirect limit', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    // Always redirect (to a public host) → the hop budget is exhausted.
    fetchMock.mockResolvedValue(redirectResponse('https://93.184.216.34/loop.pdf'));
    await expect(fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx)).rejects.toMatchObject({
      data: { reason: 'source_unfetchable' },
    });
  });
});

/**
 * Error-leak defense: the guard must never surface raw upstream internals
 * (statusCode, responseBody, requestId, the request URL) to the client. Whatever
 * the underlying fetch throws — a raw network rejection or a status-mapped
 * framework McpError carrying those internals in `data` — the client-facing error
 * must be the clean `source_unfetchable` shape, with the original confined to
 * `cause` (server-side logs only).
 */
describe('fetchPdfGuarded error-leak defense (stubbed fetch)', () => {
  const PUBLIC = 'https://93.184.216.34/form.pdf';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('normalizes a raw network rejection to a clean source_unfetchable error', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'));
    const err = await fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.data).toMatchObject({ reason: 'source_unfetchable' });
    for (const key of LEAK_KEYS) expect(err.data).not.toHaveProperty(key);
  });

  it('detects a framework McpError structurally and strips its upstream internals', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    // Exactly what the framework's fetchWithTimeout throws on a non-2xx upstream:
    // a status-mapped McpError whose `data` carries statusCode / responseBody /
    // requestId / the internal request URL. None may reach the client.
    fetchMock.mockRejectedValueOnce(
      new McpError(
        JsonRpcErrorCode.Forbidden,
        'Fetch failed for https://internal.svc/secret. Status: 403',
        {
          requestId: 'req-abc-123',
          operation: 'fetch GET https://internal.svc/secret',
          statusCode: 403,
          statusText: 'Forbidden',
          responseBody: '<html><body>Internal access token: sk-LEAKED-9f8e7d</body></html>',
          errorSource: 'FetchHttpError',
        },
      ),
    );

    const err = await fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx).catch((e) => e as McpError);

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'source_unfetchable' });
    // The client-facing `data` must carry NONE of the upstream internals.
    for (const key of LEAK_KEYS) expect(err.data).not.toHaveProperty(key);
    // Neither the leaked body, the internal host, nor the status text may appear
    // anywhere in the client-facing message or serialized data.
    const surface = `${err.message} ${JSON.stringify(err.data)}`;
    expect(surface).not.toContain('internal.svc');
    expect(surface).not.toContain('sk-LEAKED');
    expect(surface).not.toContain('responseBody');
    expect(surface).not.toContain('403');
    // The original (with internals) is retained as `cause` for server-side logs.
    expect(err.cause).toBeInstanceOf(McpError);
    expect((err.cause as McpError).data).toMatchObject({ statusCode: 403 });
  });

  it('maps caller cancellation to a clean source_unfetchable error', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 't1', signal: controller.signal });
    fetchMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    const err = await fetchPdfGuarded(PUBLIC, 1_000_000, 5000, ctx).catch((e) => e as McpError);
    expect(err).toBeInstanceOf(McpError);
    expect(err.data).toMatchObject({ reason: 'source_unfetchable' });
    for (const key of LEAK_KEYS) expect(err.data).not.toHaveProperty(key);
  });
});

/**
 * The DNS-resolution branch: a hostname host resolves through `node:dns` lookup.
 * The design calls out round-robin DNS (one public record, one private) as a case
 * the guard must block — so the lookup is mocked to control resolved addresses.
 */
describe('fetchPdfGuarded DNS resolution (mocked lookup)', () => {
  const lookupMock = vi.mocked(lookup);
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches when the hostname resolves to a public address', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never);
    fetchMock.mockResolvedValueOnce(pdfResponse(PDF_BYTES));
    await expect(
      fetchPdfGuarded('https://example.com/form.pdf', 1_000_000, 5000, ctx),
    ).resolves.toBeDefined();
  });

  it('blocks when ANY resolved address is private (round-robin DNS)', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ] as never);
    await expect(
      fetchPdfGuarded('https://example.com/form.pdf', 1_000_000, 5000, ctx),
    ).rejects.toMatchObject({ data: { reason: 'source_unfetchable' } });
    // Guard fails before any fetch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when DNS resolution throws', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(
      fetchPdfGuarded('https://nope.invalid/form.pdf', 1_000_000, 5000, ctx),
    ).rejects.toMatchObject({ data: { reason: 'source_unfetchable' } });
  });

  it('fails closed when DNS resolves to no addresses', async () => {
    const ctx = createMockContext({ tenantId: 't1' });
    lookupMock.mockResolvedValueOnce([] as never);
    await expect(
      fetchPdfGuarded('https://empty.example/form.pdf', 1_000_000, 5000, ctx),
    ).rejects.toMatchObject({ data: { reason: 'source_unfetchable' } });
  });
});
