import { describe, expect, it, vi } from 'vitest';
import { MetricsCounters } from '../../src/metrics/counters.js';

describe('MetricsCounters', () => {
  it('increments totalRequests synchronously and quickly', () => {
    const c = new MetricsCounters();
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      c.totalRequests++;
    }
    const ms = performance.now() - t0;
    expect(c.totalRequests).toBe(100_000);
    expect(ms).toBeLessThan(50);
  });

  it('ring buffer wraps correctly when full (capacity 4)', () => {
    const c = new MetricsCounters({ sampleCapacity: 4 });
    const t = 1_000_000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => t);
    for (let i = 0; i < 6; i++) {
      c.recordLatency(t - (i + 1) * 0.01);
    }
    spy.mockRestore();

    const snap = c.snapshot();
    expect(snap.latencySamplesMs.length).toBe(4);
    // When full, drain is oldest-first in ring order: slots hold 5th–6th writes then 3rd–4th
    // (see drainRing when count === cap), so values are 0.03, 0.04, 0.05, 0.06 for synthetic deltas 0.01…0.06.
    expect(snap.latencySamplesMs[0]).toBeCloseTo(0.03, 5);
    expect(snap.latencySamplesMs[3]).toBeCloseTo(0.06, 5);
  });

  it('ring buffer wraps with 1024+ samples', () => {
    const cap = 1024;
    const c = new MetricsCounters({ sampleCapacity: cap });
    const t = performance.now();
    for (let i = 0; i < cap + 100; i++) {
      c.recordLatency(t - i * 1e-6);
    }
    const snap = c.snapshot();
    expect(snap.latencySamplesMs.length).toBe(cap);
  });

  it('recordLatency stores measured deltas from startTime', () => {
    const c = new MetricsCounters({ sampleCapacity: 8 });
    const start = performance.now();
    c.recordLatency(start);
    const snap = c.snapshot();
    expect(snap.latencySamplesMs.length).toBe(1);
    expect(snap.latencySamplesMs[0]).toBeGreaterThanOrEqual(0);
    expect(snap.latencySamplesMs[0]).toBeLessThan(500);
  });

  it('evicts lowest-count key when hot key map is full', () => {
    const c = new MetricsCounters({ hotKeyMaxEntries: 3 });
    c.recordKey('a');
    c.recordKey('b');
    c.recordKey('c');
    c.recordKey('d');
    const snap = c.snapshot();
    expect(snap.hotKeys.has('d')).toBe(true);
    expect(snap.hotKeys.get('d')?.hits).toBe(1);
    expect(snap.hotKeys.get('d')?.blocked).toBe(0);
    const keys = [...snap.hotKeys.keys()];
    expect(keys).not.toContain('a');
  });

  it('clears hot-key map after snapshot so counts are per-interval', () => {
    const c = new MetricsCounters();
    c.recordKey('x');
    c.recordKey('x');
    expect(c.snapshot().hotKeys.get('x')?.hits).toBe(2);
    c.recordKey('y');
    expect(c.snapshot().hotKeys.get('x')).toBeUndefined();
    expect(c.snapshot().hotKeys.size).toBe(0);
  });

  it('tracks blocked per key after recordKey', () => {
    const c = new MetricsCounters();
    c.recordKey('k');
    c.recordKeyBlocked('k');
    c.recordKey('k');
    c.recordKeyBlocked('k');
    const snap = c.snapshot();
    expect(snap.hotKeys.get('k')?.hits).toBe(2);
    expect(snap.hotKeys.get('k')?.blocked).toBe(2);
  });

  it('snapshot returns frozen object; drains latency rings but keeps aggregate counters', () => {
    const c = new MetricsCounters();
    c.totalRequests = 42;
    c.allowedRequests = 40;
    c.recordLatency(performance.now() - 1);
    const snap = c.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.latencySamplesMs)).toBe(true);
    expect(snap.totalRequests).toBe(42);
    expect(snap.allowedRequests).toBe(40);
    expect(c.totalRequests).toBe(42);
    const snap2 = c.snapshot();
    expect(snap2.latencySamplesMs.length).toBe(0);
  });

  it('hot path recordLatency does not allocate per call (100K calls under budget)', () => {
    const c = new MetricsCounters();
    const t = performance.now();
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      c.recordLatency(t);
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
  });
});
