import { afterEach, describe, expect, it } from 'vitest';
import { resolveHeaderConfig, resolveWindowMsForHeaders } from '../../src/headers/resolveConfig.js';
import { getLimit, mergeRateLimiterOptions } from '../../src/middleware/merge-options.js';
import type { RateLimitOptions, WindowRateLimitOptions } from '../../src/types/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const groupedLimits = [
  { windowMs: 60_000, max: 100 },
  { windowMs: 3_600_000, max: 1000 },
] as const;

function mergedGrouped(): RateLimitOptions {
  return mergeRateLimiterOptions({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    limits: [...groupedLimits],
  });
}

async function shutdownGroupedStores(opts: RateLimitOptions): Promise<void> {
  const w = opts as WindowRateLimitOptions;
  if (w.groupedWindowStores && w.groupedWindowStores.length > 0) {
    await Promise.all(w.groupedWindowStores.map((g) => g.store.shutdown()));
  } else {
    await opts.store.shutdown();
  }
}

describe('resolveWindowMsForHeaders / getLimit / resolveHeaderConfig (grouped windows)', () => {
  let opts: RateLimitOptions | undefined;

  afterEach(async () => {
    if (opts !== undefined) {
      await shutdownGroupedStores(opts);
      opts = undefined;
    }
  });

  it("grouped windows, blocked on first window: policy header reflects first window's limit and windowMs", () => {
    opts = mergedGrouped();
    const bindingSlotIndex = 0;
    expect(resolveWindowMsForHeaders(opts, bindingSlotIndex)).toBe(60_000);
    expect(getLimit(opts, undefined, bindingSlotIndex)).toBe(100);
  });

  it("grouped windows, blocked on second window: policy header reflects second window's limit and windowMs", () => {
    opts = mergedGrouped();
    const bindingSlotIndex = 1;
    expect(resolveWindowMsForHeaders(opts, bindingSlotIndex)).toBe(3_600_000);
    expect(getLimit(opts, undefined, bindingSlotIndex)).toBe(1000);
  });

  it('grouped windows, no bindingSlotIndex: falls back to Math.min (backward compat)', () => {
    opts = mergedGrouped();
    expect(resolveWindowMsForHeaders(opts)).toBe(60_000);
    expect(getLimit(opts, undefined)).toBe(100);
  });

  it('explicit identifier still overrides regardless of binding slot', () => {
    opts = mergeRateLimiterOptions({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      limits: [...groupedLimits],
      identifier: 'custom-policy-id',
    });
    const cfg = resolveHeaderConfig(opts, undefined, 1);
    expect(cfg.identifier).toBe('custom-policy-id');
  });

  it('default identifier derives from binding slot', () => {
    opts = mergedGrouped();
    const cfg = resolveHeaderConfig(opts, undefined, 1);
    expect(cfg.identifier).toBe('1000-per-3600');
  });
});
