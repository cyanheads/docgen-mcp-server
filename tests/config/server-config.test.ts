/**
 * @fileoverview Server-config validation tests — the DOCGEN_* env gates parsed by
 * getServerConfig(): defaults, numeric bounds, and the deferred-engine rejection
 * (chromium is reserved but not implemented, so it must fail at parse time).
 * @module tests/config/server-config
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

describe('getServerConfig', () => {
  beforeEach(() => {
    resetServerConfig();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('applies documented defaults when no DOCGEN_* env vars are set', () => {
    const cfg = getServerConfig();
    expect(cfg.documentTtlSeconds).toBe(900);
    expect(cfg.maxDocumentBytes).toBe(26_214_400);
    expect(cfg.renderTimeoutMs).toBe(30_000);
    expect(cfg.inlineMaxBytes).toBe(5_242_880);
    expect(cfg.pdfEngine).toBe('lightweight');
  });

  it('coerces numeric env vars from strings', () => {
    vi.stubEnv('DOCGEN_DOCUMENT_TTL_SECONDS', '120');
    vi.stubEnv('DOCGEN_INLINE_MAX_BYTES', '0');
    resetServerConfig();
    const cfg = getServerConfig();
    expect(cfg.documentTtlSeconds).toBe(120);
    expect(cfg.inlineMaxBytes).toBe(0); // nonnegative — zero is allowed
  });

  it('memoizes — a second call returns the same object', () => {
    const a = getServerConfig();
    const b = getServerConfig();
    expect(a).toBe(b);
  });

  it('rejects the unimplemented chromium engine at parse time', () => {
    vi.stubEnv('DOCGEN_PDF_ENGINE', 'chromium');
    resetServerConfig();
    expect(() => getServerConfig()).toThrow(/chromium is not implemented/i);
  });

  it('rejects a non-positive TTL', () => {
    vi.stubEnv('DOCGEN_DOCUMENT_TTL_SECONDS', '0');
    resetServerConfig();
    expect(() => getServerConfig()).toThrow();
  });

  it('rejects a non-positive render timeout', () => {
    vi.stubEnv('DOCGEN_RENDER_TIMEOUT_MS', '-1');
    resetServerConfig();
    expect(() => getServerConfig()).toThrow();
  });

  it('rejects a non-numeric byte ceiling', () => {
    vi.stubEnv('DOCGEN_MAX_DOCUMENT_BYTES', 'lots');
    resetServerConfig();
    expect(() => getServerConfig()).toThrow();
  });

  it('rejects an unknown PDF engine', () => {
    vi.stubEnv('DOCGEN_PDF_ENGINE', 'webkit');
    resetServerConfig();
    expect(() => getServerConfig()).toThrow();
  });
});
