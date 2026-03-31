/**
 * Fixed-bucket latency histogram: O(log b) {@link Histogram.observe} via binary search.
 * Bucket counts use a pre-allocated buffer — no allocations after construction.
 *
 * @example
 * ```ts
 * const h = new Histogram([1, 5, 10, 50]);
 * h.observe(3.2);
 * const dist = h.getDistribution();
 * ```
 *
 * @since 1.3.0
 */
export class Histogram {
  private readonly _buckets: readonly number[];

  /** Length = buckets.length + 1 (last slot is overflow). */
  private readonly counts: Float64Array;

  private _totalCount = 0;

  private _sum = 0;

  /**
   * @param buckets - Strictly ascending upper bounds (ms). Intervals are
   *   `[buckets[i-1], buckets[i])` with `buckets[-1]` treated as 0 for the first bucket when values are non-negative.
   *   Index `i` counts values `v` with all `buckets[j] <= v` for `j < i` and `v < buckets[i]` (or overflow when `i === buckets.length`).
   */
  constructor(buckets: readonly number[]) {
    const sorted = buckets.length === 0 ? [] : [...buckets].sort((a, b) => a - b);
    this._buckets = sorted;
    this.counts = new Float64Array(sorted.length + 1);
  }

  get buckets(): readonly number[] {
    return this._buckets;
  }

  /** Total number of {@link Histogram.observe} calls. */
  get count(): number {
    return this._totalCount;
  }

  /** Sum of all observed values. */
  get sum(): number {
    return this._sum;
  }

  /**
   * Increment the bucket for `value` in O(log b) time.
   */
  observe(value: number): void {
    const idx = bucketIndex(value, this._buckets);
    this.counts[idx] = this.counts[idx]! + 1;
    this._totalCount++;
    this._sum += value;
  }

  /**
   * All buckets with counts and running cumulative counts.
   * (Allocates the result array — the histogram storage itself does not grow.)
   */
  getDistribution(): { bucket: number; count: number; cumulative: number }[] {
    const out: { bucket: number; count: number; cumulative: number }[] = [];
    let cumulative = 0;
    const b = this._buckets;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i]!;
      cumulative += c;
      const bucket = i < b.length ? b[i]! : Number.POSITIVE_INFINITY;
      out.push({ bucket, count: c, cumulative });
    }
    return out;
  }

  reset(): void {
    this.counts.fill(0);
    this._totalCount = 0;
    this._sum = 0;
  }

  /**
   * Pointwise sum of counts and sums. Both histograms must have identical `buckets`.
   */
  merge(other: Histogram): Histogram {
    if (this._buckets.length !== other._buckets.length) {
      throw new Error('Histogram.merge: bucket arrays must have the same length');
    }
    for (let i = 0; i < this._buckets.length; i++) {
      if (this._buckets[i] !== other._buckets[i]) {
        throw new Error('Histogram.merge: bucket boundaries must match');
      }
    }
    const merged = new Histogram([...this._buckets]);
    for (let i = 0; i < this.counts.length; i++) {
      merged.counts[i] = this.counts[i]! + other.counts[i]!;
    }
    merged._totalCount = this._totalCount + other._totalCount;
    merged._sum = this._sum + other._sum;
    return merged;
  }
}

/**
 * Smallest `i` in `[0, buckets.length]` with `value < buckets[i]` (first upper bound strictly above `value`);
 * if none, `buckets.length` (overflow bucket).
 */
function bucketIndex(value: number, buckets: readonly number[]): number {
  let lo = 0;
  let hi = buckets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid]! > value) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}
