/**
 * @fileoverview SSRF-guarded PDF fetcher shared by the two PDF form tools.
 * Enforces https-only, blocks private/loopback/link-local/cloud-metadata
 * destinations by resolving DNS and checking the resolved IP (not just the
 * hostname), binds a fresh HTTPS connection to a vetted address with TLS identity
 * preserved, and follows redirects while re-validating each hop,
 * accepts `application/pdf` and PDF-signature `application/octet-stream` bodies,
 * and caps the response body at the configured byte ceiling before buffering.
 * Every failure path — including a raw network
 * rejection or a status-mapped framework `McpError` whose `data` carries upstream
 * internals (statusCode, responseBody, requestId, the request URL) — is caught and
 * re-thrown as a clean `source_unfetchable` domain error so none of those internals
 * reach the client; the original rides as `cause` for server-side logs only.
 * @module services/document/fetch-guard
 */

import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { type RequestOptions, request } from 'node:https';
import { isIP } from 'node:net';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

const MAX_REDIRECTS = 3;
const CONNECT_STAGGER_MS = 1000;
const FETCH_REASON = 'source_unfetchable';
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const RETRYABLE_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]);

type VettedAddress = { address: string; family: number };

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
    if (ip.includes('%')) return true;
    const lower = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (/^fe[89ab]/.test(lower)) return true; // link-local /10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    if (lower.startsWith('ff')) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4 address.
    const mapped = lower.match(/^::ffff:([\da-f]+):([\da-f]+)$/);
    if (mapped) {
      const n =
        Number.parseInt(mapped[1] as string, 16) * 65536 + Number.parseInt(mapped[2] as string, 16);
      return isBlockedIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return false;
  }

  return true; // not a recognizable IP literal → fail closed
}

/**
 * Resolves a hostname to all candidate addresses and throws `source_unfetchable`
 * if ANY resolved address is blocked (defends against round-robin DNS where one
 * record is public and another private). A literal IP host is checked directly.
 */
async function assertHostAllowed(
  hostname: string,
  ctx: Context,
  signal: AbortSignal,
): Promise<VettedAddress[]> {
  const fail = (detail: string) =>
    serviceUnavailable(`Refusing to fetch ${hostname}: ${detail}`, {
      reason: FETCH_REASON,
      ...ctx.recoveryFor(FETCH_REASON),
    });

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw fail('destination IP is private, loopback, or link-local');
    return [{ address: hostname, family: isIP(hostname) }];
  }

  let addresses: VettedAddress[];
  let onAbort: (() => void) | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } catch {
    signal.throwIfAborted();
    throw fail('DNS resolution failed');
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  const [first] = addresses;
  if (!first) throw fail('DNS resolved to no addresses');
  const primary: VettedAddress[] = [];
  const alternate: VettedAddress[] = [];
  for (const candidate of addresses) {
    if (isBlockedIp(candidate.address))
      throw fail('resolves to a private, loopback, or link-local address');
    (candidate.family === first.family ? primary : alternate).push(candidate);
  }
  const ordered: VettedAddress[] = [];
  for (let i = 0; i < Math.max(primary.length, alternate.length); i++) {
    const primaryAddress = primary[i];
    const alternateAddress = alternate[i];
    if (primaryAddress) ordered.push(primaryAddress);
    if (alternateAddress) ordered.push(alternateAddress);
  }
  return ordered;
}

/**
 * Opens a fresh HTTPS connection to a vetted address while preserving URL TLS
 * identity and Host. Exposed for socket-level transport tests, not tool callers.
 * @internal
 */
export function requestPdfAtAddress(
  url: URL,
  approved: VettedAddress,
  signal: AbortSignal,
  onConnected: () => void = () => {},
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: 'GET',
      agent: false,
      signal,
      autoSelectFamily: false,
      headers: { Accept: 'application/pdf' },
      lookup: (_hostname, _options, callback) => callback(null, approved.address, approved.family),
    };
    const req = request(url, options, resolve);
    req.once('socket', (socket) => {
      // A refused Bun socket can already have connecting=false at this point.
      if (socket.remoteAddress) onConnected();
      else socket.once('connect', onConnected);
    });
    req.once('error', reject);
    req.end();
  });
}

/** Only TCP establishment can advance to another vetted DNS answer. */
function requestPdf(
  url: URL,
  addresses: VettedAddress[],
  signal: AbortSignal,
  staggerMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const pending = new Set<AbortController>();
    let cursor = 0;
    let stagger: ReturnType<typeof setTimeout> | undefined;
    let winner: AbortController | undefined;

    function keepOnly(attempt?: AbortController) {
      clearTimeout(stagger);
      for (const other of pending) {
        if (other === attempt) continue;
        pending.delete(other);
        other.abort();
      }
    }

    function dial() {
      const address = addresses[cursor];
      if (!address || signal.aborted) return;
      const position = ++cursor;
      const attempt = new AbortController();
      pending.add(attempt);
      const onConnected = () => {
        if (winner || !pending.has(attempt)) return;
        winner = attempt;
        keepOnly(attempt);
      };

      requestPdfAtAddress(
        url,
        address,
        AbortSignal.any([signal, attempt.signal]),
        onConnected,
      ).then(
        (response) => {
          onConnected();
          if (winner === attempt) resolve(response);
          else response.destroy();
        },
        (error: unknown) => {
          if (!pending.delete(attempt)) return;
          const retryable =
            error instanceof Error &&
            'syscall' in error &&
            error.syscall === 'connect' &&
            'code' in error &&
            typeof error.code === 'string' &&
            RETRYABLE_CONNECT_CODES.has(error.code);
          if (signal.aborted || winner || !retryable) {
            keepOnly();
            reject(error);
          } else if (cursor < addresses.length) {
            if (position === cursor) {
              clearTimeout(stagger);
              dial();
            }
          } else if (!pending.size) {
            reject(error);
          }
        },
      );

      // Keep the oldest pending dial eligible. Rotate the fallback slot on a
      // TCP timeout so a large DNS answer cannot create an unbounded race.
      if (!winner && cursor < addresses.length) {
        stagger = setTimeout(() => {
          if (pending.size === 2) {
            pending.delete(attempt);
            attempt.abort();
          }
          dial();
        }, staggerMs);
      }
    }

    signal.throwIfAborted();
    dial();
  });
}

/**
 * Fetches a PDF from a caller-supplied URL behind the SSRF guard. Throws
 * `source_unfetchable` (ServiceUnavailable) on any guard violation: non-https
 * scheme, blocked destination, non-2xx status, wrong content-type, oversized
 * body, or too many redirects. Manual redirect following re-runs the full guard
 * on every hop. Honors `ctx.signal` and the configured render timeout via an
 * AbortController. A raw network rejection or a status-mapped framework `McpError`
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
  const staggerMs = Math.min(CONNECT_STAGGER_MS, timeoutMs / 2);

  try {
    if (ctx.signal.aborted) {
      controller.abort();
      controller.signal.throwIfAborted();
    }
    let currentUrl = rawUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw fail('the URL is malformed');
      }
      if (parsed.protocol !== 'https:') throw fail('only https URLs are allowed');

      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      const addresses = await assertHostAllowed(hostname, ctx, controller.signal);
      const response = await requestPdf(parsed, addresses, controller.signal, staggerMs);
      try {
        // Follow redirects manually so each hop is re-validated by the guard.
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          if (!location) throw fail(`redirect ${status} had no Location header`);
          if (hop === MAX_REDIRECTS) throw fail('too many redirects');
          currentUrl = new URL(location, parsed).toString();
          continue;
        }

        if (status < 200 || status >= 300) throw fail(`the server returned HTTP ${status}`);

        const contentType = response.headers['content-type'] ?? '';
        const isPdf = /^application\/pdf\b/i.test(contentType);
        const isOctetStream = !isPdf && /^application\/octet-stream\s*(?:;|$)/i.test(contentType);
        if (!isPdf && !isOctetStream) {
          throw fail(
            `expected application/pdf or application/octet-stream but got "${contentType || 'no content-type'}"`,
          );
        }

        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          throw fail(`the response is ${declaredLength} bytes, over the ${maxBytes}-byte limit`);
        }

        const bytes = await readBodyCapped(response, maxBytes, isOctetStream, fail);
        controller.signal.throwIfAborted();
        ctx.log.info('Fetched source PDF', {
          host: parsed.hostname,
          byteSize: bytes.byteLength,
        });
        return bytes;
      } finally {
        response.destroy();
      }
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
  response: IncomingMessage,
  maxBytes: number,
  requireSignature: boolean,
  fail: (detail: string) => Error,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const invalidSignature = () =>
    fail('application/octet-stream did not start with the %PDF- signature');
  for await (const value of response) {
    const nextTotal = total + value.byteLength;
    if (nextTotal > maxBytes) {
      response.destroy();
      throw fail(`the response exceeds the ${maxBytes}-byte limit`);
    }
    if (requireSignature) {
      for (let offset = total; offset < Math.min(nextTotal, PDF_SIGNATURE.length); offset++) {
        if (value[offset - total] !== PDF_SIGNATURE[offset]) throw invalidSignature();
      }
    }
    total = nextTotal;
    chunks.push(value);
  }
  if (requireSignature && total < PDF_SIGNATURE.length) throw invalidSignature();

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
