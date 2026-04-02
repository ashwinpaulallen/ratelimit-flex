import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultRateLimitIdentifier,
  formatRateLimitHeaders,
  sanitizeIdentifierFor8941,
} from '../../src/headers/formatHeaders.js';

describe('formatRateLimitHeaders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseInput = () => ({
    limit: 100,
    remaining: 42,
    resetTime: new Date('2026-06-01T12:01:30.000Z'),
    isBlocked: false,
    windowMs: 60_000,
    identifier: defaultRateLimitIdentifier(100, 60_000),
  });

  it('legacy: X-RateLimit-* with epoch reset, no Retry-After when not blocked', () => {
    const out = formatRateLimitHeaders(baseInput(), 'legacy', false);
    expect(out.headers).toEqual({
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': String(Math.ceil(new Date('2026-06-01T12:01:30.000Z').getTime() / 1000)),
    });
    expect(out.headers['Retry-After']).toBeUndefined();
    expect(out.legacyHeaders).toBeUndefined();
  });

  it('legacy: Retry-Only when isBlocked (seconds until reset, non-negative)', () => {
    const resetTime = new Date('2026-06-01T12:00:45.000Z');
    const out = formatRateLimitHeaders(
      {
        ...baseInput(),
        remaining: 0,
        resetTime,
        isBlocked: true,
      },
      'legacy',
      false,
    );
    expect(out.headers['Retry-After']).toBe('45');
  });

  it('draft-6: RateLimit-* with seconds-until-reset, not epoch', () => {
    const out = formatRateLimitHeaders(baseInput(), 'draft-6', false);
    expect(out.headers).toMatchObject({
      'RateLimit-Limit': '100',
      'RateLimit-Remaining': '42',
      'RateLimit-Reset': '90',
      'RateLimit-Policy': '100;w=60',
    });
    expect(out.headers['Retry-After']).toBeUndefined();
  });

  it('draft-7: combined RateLimit header', () => {
    const out = formatRateLimitHeaders(baseInput(), 'draft-7', false);
    expect(out.headers).toEqual({
      RateLimit: 'limit=100, remaining=42, reset=90',
      'RateLimit-Policy': '100;w=60',
    });
  });

  it('draft-8: RFC 8941-style quoted identifier on RateLimit and RateLimit-Policy', () => {
    const out = formatRateLimitHeaders(
      {
        ...baseInput(),
        identifier: '100-per-60',
      },
      'draft-8',
      false,
    );
    expect(out.headers).toEqual({
      'RateLimit-Policy': '"100-per-60";q=100;w=60',
      RateLimit: '"100-per-60";r=42;t=90',
    });
  });

  it('Retry-After only when isBlocked', () => {
    const blocked = { ...baseInput(), isBlocked: true };
    expect(formatRateLimitHeaders(blocked, 'draft-6', false).headers['Retry-After']).toBe('90');
    expect(formatRateLimitHeaders(blocked, 'draft-7', false).headers['Retry-After']).toBe('90');
    expect(formatRateLimitHeaders(blocked, 'draft-8', false).headers['Retry-After']).toBe('90');
    expect(formatRateLimitHeaders({ ...baseInput(), isBlocked: false }, 'draft-6', false).headers['Retry-After']).toBeUndefined();
  });

  it('remaining never below 0', () => {
    const out = formatRateLimitHeaders({ ...baseInput(), remaining: -5 }, 'legacy', false);
    expect(out.headers['X-RateLimit-Remaining']).toBe('0');
    expect(formatRateLimitHeaders({ ...baseInput(), remaining: -1 }, 'draft-6', false).headers['RateLimit-Remaining']).toBe('0');
  });

  it('secondsUntilReset never below 0 (reset in the past)', () => {
    vi.setSystemTime(new Date('2026-06-01T12:02:00.000Z'));
    const out = formatRateLimitHeaders(
      {
        ...baseInput(),
        resetTime: new Date('2026-06-01T12:01:00.000Z'),
        isBlocked: true,
      },
      'draft-6',
      false,
    );
    expect(out.headers['RateLimit-Reset']).toBe('0');
    expect(out.headers['Retry-After']).toBe('0');
  });

  it('includeLegacy=true adds legacyHeaders alongside draft-6', () => {
    const out = formatRateLimitHeaders(baseInput(), 'draft-6', true);
    expect(out.headers['RateLimit-Limit']).toBe('100');
    const epoch = String(Math.ceil(new Date('2026-06-01T12:01:30.000Z').getTime() / 1000));
    expect(out.legacyHeaders).toEqual({
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': epoch,
    });
  });

  it('includeLegacy with legacy format does not duplicate legacyHeaders', () => {
    const out = formatRateLimitHeaders(baseInput(), 'legacy', true);
    expect(out.legacyHeaders).toBeUndefined();
    expect(out.headers['X-RateLimit-Limit']).toBe('100');
  });

  it('sanitizeIdentifierFor8941 and draft-8 with weird characters', () => {
    expect(sanitizeIdentifierFor8941('a\tb\u{1F600}c')).toBe('a-b--c');
    const out = formatRateLimitHeaders(
      {
        ...baseInput(),
        identifier: 'bad\tid',
      },
      'draft-8',
      false,
    );
    expect(out.headers['RateLimit-Policy']).toContain('"bad-id"');
    expect(out.headers.RateLimit).toContain('"bad-id"');
  });

  it('defaultRateLimitIdentifier returns limit-per-windowSeconds', () => {
    expect(defaultRateLimitIdentifier(100, 60_000)).toBe('100-per-60');
    expect(defaultRateLimitIdentifier(10, 30_000)).toBe('10-per-30');
    expect(defaultRateLimitIdentifier(5, 500)).toBe('5-per-1');
  });
});
