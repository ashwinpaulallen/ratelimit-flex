import { describe, expect, it } from 'vitest';
import { Histogram, assertHistogramBucketBounds } from '../../src/metrics/histogram.js';

describe('Histogram', () => {
  it('throws when bucket bounds are empty, unsorted, duplicate, or non-positive', () => {
    expect(() => new Histogram([])).toThrow(/non-empty/);
    expect(() => new Histogram([10, 5, 20])).toThrow(/ascending/);
    expect(() => new Histogram([1, 1, 2])).toThrow(/ascending/);
    expect(() => new Histogram([0, 1])).toThrow(/> 0/);
  });

  it('assertHistogramBucketBounds uses label in error messages', () => {
    expect(() => assertHistogramBucketBounds([], 'metrics.histogramBuckets')).toThrow(/metrics\.histogramBuckets/);
  });

  it('places values into correct buckets', () => {
    const h = new Histogram([0.1, 0.5, 1, 2]);
    h.observe(0.05);
    h.observe(0.2);
    h.observe(0.7);
    h.observe(5);
    const d = h.getDistribution();
    expect(d.map((x) => x.count)).toEqual([1, 1, 1, 0, 1]);
  });

  it('cumulative counts are monotonic and end at total count', () => {
    const h = new Histogram([1, 2, 3]);
    h.observe(0.5);
    h.observe(1.5);
    h.observe(2.5);
    h.observe(10);
    const d = h.getDistribution();
    let prev = 0;
    for (const row of d) {
      expect(row.cumulative).toBeGreaterThanOrEqual(prev);
      prev = row.cumulative;
    }
    expect(d[d.length - 1]!.cumulative).toBe(h.count);
  });

  it('binary search: value exactly on bucket boundary goes to next bucket (strict upper bound)', () => {
    const h = new Histogram([0.1, 0.5, 1]);
    h.observe(0.1);
    h.observe(0.5);
    h.observe(1);
    const d = h.getDistribution();
    expect(d[0]!.count).toBe(0);
    expect(d[1]!.count).toBe(1);
    expect(d[2]!.count).toBe(1);
    expect(d[3]!.count).toBe(1);
  });

  it('reset() clears all buckets, sum, and count', () => {
    const h = new Histogram([1, 2]);
    h.observe(0.5);
    h.observe(1.5);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.sum).toBe(0);
    expect(h.getDistribution().every((x) => x.count === 0)).toBe(true);
  });

  it('merge() combines two histograms with identical buckets', () => {
    const a = new Histogram([1, 2, 3]);
    a.observe(0.5);
    a.observe(2.5);
    const b = new Histogram([1, 2, 3]);
    b.observe(1.5);
    b.observe(10);
    const m = a.merge(b);
    expect(m.count).toBe(4);
    expect(m.sum).toBeCloseTo(0.5 + 2.5 + 1.5 + 10);
    expect(() => a.merge(new Histogram([1, 2]))).toThrow(/same length/);
  });
});
