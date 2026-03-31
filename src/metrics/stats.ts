import { percentile as percentileInPlace } from './percentile.js';

function cloneSamples(samples: readonly number[]): number[] {
  return samples.length === 0 ? [] : Array.from(samples);
}

/** Same rank index as {@link percentileInPlace} / `percentile.ts`. */
function percentileRankIndex(n: number, p: number): number {
  return Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
}

/**
 * Nearest-rank percentiles for several `ps` with **one** clone of `samples` and one sort (O(n log n)).
 * Prefer this over multiple {@link percentileQuick} calls when you need several percentiles of the same data.
 */
export function percentilesQuick(samples: readonly number[], ps: readonly number[]): number[] {
  const n = samples.length;
  if (n === 0) return ps.map(() => 0);
  const a = cloneSamples(samples);
  a.sort((x, y) => x - y);
  const out: number[] = new Array(ps.length);
  for (let i = 0; i < ps.length; i++) {
    const k = percentileRankIndex(n, ps[i]!);
    out[i] = a[k]!;
  }
  return out;
}

/**
 * Nearest-rank percentile using in-place quickselect (clone first). O(n) per call.
 */
export function percentileQuick(samples: readonly number[], p: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const a = cloneSamples(samples);
  return percentileInPlace(a, p);
}

export function minMaxMean(samples: readonly number[]): { min: number; max: number; mean: number } {
  if (samples.length === 0) {
    return { min: 0, max: 0, mean: 0 };
  }
  let minV = samples[0]!;
  let maxV = samples[0]!;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    sum += v;
  }
  return { min: minV, max: maxV, mean: sum / samples.length };
}

export function standardDeviation(samples: readonly number[], mean: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = samples[i]! - mean;
    s += d * d;
  }
  return Math.sqrt(s / n);
}
