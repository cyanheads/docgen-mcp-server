/**
 * @fileoverview SSRF-guarded PDF fetcher for the `docgen_fill_form` URL source.
 * Enforces https-only, blocks private/loopback/link-local/cloud-metadata
 * destinations by resolving DNS and checking the resolved IP (not just the
 * hostname), follows redirects up to a fixed limit while re-validating each hop,
 * verifies `application/pdf`, and caps the response body at the configured byte
 * ceiling before buffering. Every failure path — including a raw network
 * rejection or a status-mapped framework `McpError` whose `data` carries upstream
 * internals (statusCode, responseBody, requestId, the request URL) — is caught and
 * re-thrown as a clean `source_unfetchable` domain error so none of those internals
 * reach the client; the original rides as `cause` for server-side logs only.
 * @module services/document/fetch-guard
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

const MAX_REDIRECTS = 3;
const FETCH_REASON = 'source_unfetchable';

/**
 * True for an error this guard itself raised — its `data.reason` is already the
 * leak-free `source_unfetchable` shape (`{ reason, recovery }`). Detected
 * structurally, never by message string, so re-throwing it as-is is safe.
 */
function isGuardError(err: unknown): err is McpError {
  return (
    err instanceof McpError &&
    typeof err.data === 'object' &&
    err.data !== null &&
    (err.data as { reason?: unknown }).reason === FETCH_REASON
  );
}

/**
 * Parses an IPv4 dotted-quad into its 32-bit integer form, or `null` if it is
 * not a well-formed IPv4 string.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * Returns true when the given IP literal points at a private, loopback,
 * link-local, unspecified, unique-local, or cloud-metadata destination — any of
 * which must be blocked. Covers IPv4 ranges, the `169.254.169.254` metadata
 * endpoint (caught by the link-local range), and the common IPv6 cases including
 * IPv4-mapped addresses.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);

  if (family === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true; // unparseable → fail closed
    const inRange = (base: string, bits: number) => {
      const baseInt = ipv4ToInt(base);
      if (baseInt === null) return false;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (baseInt & mask);
    };
    return (
      inRange('10.0.0.0', 8) || // RFC 1918
      inRange('172.16.0.0', 12) || // RFC 1918
      inRange('192.168.0.0', 16) || // RFC 1918
      inRange('127.0.0.0', 8) || // loopback
      inRange('169.254.0.0', 16) || // link-local (includes 169.254.169.254 metadata)
      inRange('0.0.0.0', 8) || // "this network" / unspecified
      inRange('100.64.0.0', 10) || // carrier-grade NAT
      inRange('192.0.0.0', 24) || // IETF protocol assignments
      inRange('192.0.2.0', 24) || // TEST-NET-1
      inRange('198.18.0.0', 15) || // benchmarking
      inRange('198.51.100.0', 24) || // TEST-NET-2
      inRange('203.0.113.0', 24) || // TEST-NET-3
      inRange('224.0.0.0', 4) || // multicast
      inRange('240.0.0.0', 4) // reserved
    );
  }

  if (family === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4 address.
    const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedIp(mapped[1]!);
    return false;
  }

  return true; // not a recognizable IP literal → fail closed
}

/**
 * Resolves a hostname to all candidate addresses and throws `source_unfetchable`
 * if ANY resolved address is blocked (defends against round-robin DNS where one
 * record is public and another private). A literal IP host is checked directly.
 */
async function assertHostAllowed(hostname: string, ctx: Context): Promise<void> {
  const fail = (detail: string) =>
    serviceUnavailable(`Refusing to fetch ${hostname}: ${detail}`, {
      reason: FETCH_REASON,
      ...ctx.recoveryFor(FETCH_REASON),
    });

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw fail('destination IP is private, loopback, or link-local');
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw fail('DNS resolution failed');
  }
  if (addresses.length === 0) throw fail('DNS resolved to no addresses');
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw fail('resolves to a private, loopback, or link-local address');
  }
}

/**
 * Fetches a PDF from a caller-supplied URL behind the SSRF guard. Throws
 * `source_unfetchable` (ServiceUnavailable) on any guard violation: non-https
 * scheme, blocked destination, non-2xx status, wrong content-type, oversized
 * body, or too many redirects. Manual redirect following re-runs the full guard
 * on every hop. Honors `ctx.signal` and the configured render timeout via an
 * AbortController. A raw `fetch` rejection or a status-mapped framework `McpError`
 * is caught and normalized to the same leak-free `source_unfetchable` error.
 */
export async function fetchPdfGuarded(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
  ctx: Context,
): Promise<Uint8Array> {
  const fail = (detail: string) =>
    serviceUnavailable(`Could not fetch the source PDF: ${detail}`, {
      reason: FETCH_REASON,
      ...ctx.recoveryFor(FETCH_REASON),
    });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let currentUrl = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw fail('the URL is malformed');
      }
      if (parsed.protocol !== 'https:') throw fail('only https URLs are allowed');

      await assertHostAllowed(parsed.hostname, ctx);

      const response = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/pdf' },
      });

      // Follow redirects manually so each hop is re-validated by the guard.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw fail(`redirect ${response.status} had no Location header`);
        if (hop === MAX_REDIRECTS) throw fail('too many redirects');
        currentUrl = new URL(location, parsed).toString();
        continue;
      }

      if (!response.ok) throw fail(`the server returned HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/pdf\b/i.test(contentType)) {
        throw fail(`expected application/pdf but got "${contentType || 'no content-type'}"`);
      }

      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw fail(`the response is ${declaredLength} bytes, over the ${maxBytes}-byte limit`);
      }

      const bytes = await readBodyCapped(response, maxBytes, fail);
      ctx.log.info('Fetched source PDF for form fill', {
        host: parsed.hostname,
        byteSize: bytes.byteLength,
      });
      return bytes;
    }

    throw fail('too many redirects');
  } catch (err) {
    // Guard-raised errors already carry the leak-free source_unfetchable shape —
    // re-throw untouched.
    if (isGuardError(err)) throw err;

    // The render timeout or caller cancellation tripped the AbortController.
    if (timedOut) throw fail('the fetch exceeded the time budget');
    if (ctx.signal.aborted)
      throw serviceUnavailable('The source PDF fetch was cancelled.', {
        reason: FETCH_REASON,
        ...ctx.recoveryFor(FETCH_REASON),
      });

    // Anything else — a raw network rejection (TypeError, TLS/connection reset,
    // DNS race) or a status-mapped framework McpError whose `data` carries raw
    // upstream internals (statusCode, responseBody, requestId, the internal URL).
    // Detected structurally; never surfaced. Re-throw the clean domain error and
    // keep the original as `cause` so only the server-side log sees the internals.
    const cause = err instanceof Error ? err : undefined;
    throw serviceUnavailable(
      'Could not fetch the source PDF: the request failed before a response was received.',
      { reason: FETCH_REASON, ...ctx.recoveryFor(FETCH_REASON) },
      cause ? { cause } : undefined,
    );
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Streams the response body, aborting as soon as the accumulated size exceeds
 * `maxBytes` so an over-limit (or chunked, length-omitted) response is rejected
 * before the whole body is buffered.
 */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  fail: (detail: string) => Error,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw fail(`the response exceeds the ${maxBytes}-byte limit`);
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw fail(`the response exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
