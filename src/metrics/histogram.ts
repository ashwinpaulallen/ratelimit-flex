/**
 * Validates upper-bound arrays for {@link Histogram} and {@link MetricsConfig.histogramBuckets}
 * (non-empty, finite, strictly positive, strictly ascending).
 *
 * @param label - Prefix for error messages (`metrics.histogramBuckets` vs `Histogram bucket bounds`).
 * @throws Error when validation fails.
 * @since 1.3.0
 */
export function assertHistogramBucketBounds(
  buckets: readonly number[],
  label = 'Histogram bucket bounds',
): void {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new Error(
      `ratelimit-flex: ${label} must be a non-empty array of positive numbers in strictly ascending order.`,
    );
  }
  for (let i = 0; i < buckets.length; i++) {
    const v = buckets[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(
        `ratelimit-flex: ${label} must contain only finite numbers > 0 (got ${String(v)} at index ${i}).`,
      );
    }
  }
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i]! <= buckets[i - 1]!) {
      throw new Error(
        `ratelimit-flex: ${label} must be sorted in strictly ascending order (invalid at index ${i}).`,
      );
    }
  }
}

/**
 * Fixed-bucket latency histogram: O(log b) {@link Histogram.observe} via binary search.
 * Bucket counts use a pre-allocated buffer — no allocations after construction.
 *
 * **Boundary semantics (not Prometheus `le`):** this class uses **right-open** finite intervals
 * aligned to the upper bounds you pass. An observation `v` is assigned to the **first** bucket
 * whose upper bound is **strictly greater** than `v` (equivalently: slot `i` holds
 * `buckets[i - 1] <= v < buckets[i]`, treating `buckets[-1]` as `0` for non‑negative latencies).
 * So with `buckets = [1, 5, 10]`, the value **`5` falls in the `[5, 10)` slot**, not the slot whose
 * label is `5`. **Prometheus** histograms use cumulative **`le`** labels (each boundary counts
 * `observations <= le`); that model is different. The package’s {@link PrometheusAdapter} does **not**
 * use this class for exposition — it applies `<=` when mapping samples to Prometheus buckets. If you
 * export {@link Histogram} counts to Prometheus yourself, re-bucket or interpret boundaries explicitly.
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
   * @param buckets - Strictly ascending upper bounds (ms); must pass {@link assertHistogramBucketBounds}
   *   (same rules as `metrics.histogramBuckets`). Slot `i` (for `i < length`) holds counts for
   *   `buckets[i - 1] <= v < buckets[i]` (with `buckets[-1] = 0` for typical non‑negative samples);
   *   the last slot is overflow `v >= buckets[length - 1]`. See class **Boundary semantics** for Prometheus.
   */
  constructor(buckets: readonly number[]) {
    assertHistogramBucketBounds(buckets);
    this._buckets = Object.freeze([...buckets]);
    this.counts = new Float64Array(this._buckets.length + 1);
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
   * Increment the bucket for `value` in O(log b) time. Uses **strict** upper bounds
   * (first `buckets[i] > value`); see class docs — not the same as Prometheus `le`.
   */
  observe(value: number): void {
    const idx = bucketIndex(value, this._buckets);
    this.counts[idx] = this.counts[idx]! + 1;
    this._totalCount++;
    this._sum += value;
  }

  /**
   * All buckets with per-bucket `count`, running `cumulative`, and `bucket` set to that row’s
   * **upper bound** label (or `+Inf` for overflow). Cumulative here is for this histogram’s layout,
   * not Prometheus cumulative `le` series.
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
 * Index of the bucket that receives `value`: smallest `i` with `value < buckets[i]`.
 * Equivalently, right-open slabs `[\_, buckets[i])` — values **equal** to a boundary fall in the **next** slab,
 * unlike Prometheus `le` histograms (see {@link Histogram} class doc).
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
