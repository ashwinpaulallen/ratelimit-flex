import { describe, expect, it } from 'vitest';
import {
  sanitizeIncrementCost,
  sanitizePenaltyDurationMs,
  sanitizeRateLimitCap,
  sanitizeWindowMs,
} from '../../src/utils/clamp.js';

const FALLBACK = 42;

function assertCapLike(
  fn: (value: unknown, fallback: number) => number,
  minValid: number,
): void {
  const edge = [
    NaN,
    Infinity,
    -Infinity,
    -1,
    0,
    0.9,
    1,
    1.9,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const v of edge) {
    const r = fn(v, FALLBACK);
    if (typeof v === 'number' && Number.isFinite(v)) {
      const floored = Math.floor(v);
      if (floored >= minValid) {
        expect(r).toBe(Math.min(floored, Number.MAX_SAFE_INTEGER));
      } else {
        expect(r).toBe(FALLBACK);
      }
    } else {
      expect(r).toBe(FALLBACK);
    }
  }

  for (let i = 0; i < 500; i++) {
    const raw = (Math.random() * 4 - 2) * Number.MAX_SAFE_INTEGER;
    const r = fn(raw, FALLBACK);
    expect(r === FALLBACK || (Number.isInteger(r) && r >= minValid && r <= Number.MAX_SAFE_INTEGER)).toBe(true);
  }
}

describe('clamp sanitizers (light property-style checks)', () => {
  it('sanitizeRateLimitCap', () => {
    assertCapLike(sanitizeRateLimitCap, 1);
  });

  it('sanitizeIncrementCost', () => {
    assertCapLike(sanitizeIncrementCost, 1);
  });

  it('sanitizeWindowMs', () => {
    assertCapLike(sanitizeWindowMs, 1);
  });

  it('sanitizePenaltyDurationMs (allows 0)', () => {
    expect(sanitizePenaltyDurationMs(-0.1, FALLBACK)).toBe(FALLBACK);
    expect(sanitizePenaltyDurationMs(0, FALLBACK)).toBe(0);
    expect(sanitizePenaltyDurationMs(0.9, FALLBACK)).toBe(0);

    for (let i = 0; i < 500; i++) {
      const raw = (Math.random() * 4 - 1) * Number.MAX_SAFE_INTEGER;
      const r = sanitizePenaltyDurationMs(raw, FALLBACK);
      expect(r === FALLBACK || (Number.isInteger(r) && r >= 0 && r <= Number.MAX_SAFE_INTEGER)).toBe(true);
    }
  });
});
