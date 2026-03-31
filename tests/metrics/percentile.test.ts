import { describe, expect, it } from 'vitest';
import { percentile } from '../../src/metrics/percentile.js';

function sortedP(arr: readonly number[], p: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const k = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[k]!;
}

describe('percentile', () => {
  it('p50 of [1,2,3,4,5] = 3', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('p99 of 10000 elements matches nearest-rank sorted reference', () => {
    const arr: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      arr.push(Math.floor(Math.random() * 1_000_000));
    }
    const copy = [...arr];
    const got = percentile(copy, 99);
    const expected = sortedP(arr, 99);
    expect(got).toBe(expected);
  });

  it('empty array returns 0', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('single element returns that element', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it('100K elements completes quickly (O(n) quickselect)', () => {
    const arr: number[] = [];
    for (let i = 0; i < 100_000; i++) {
      arr.push(i);
    }
    const t0 = performance.now();
    percentile(arr, 95);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10);
  });
});
