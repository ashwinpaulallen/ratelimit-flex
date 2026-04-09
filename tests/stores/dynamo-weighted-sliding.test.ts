import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoStore } from '../../src/stores/dynamo/DynamoStore.js';
import {
  fixedWindowBoundaryMs,
  simulateWeightedIncrement,
  weightedSlidingCount,
} from '../../src/stores/dynamo/sliding-weighted.js';
import { RateLimitStrategy } from '../../src/types/index.js';

function exactSlidingCount(now: number, windowMs: number, eventTimes: number[]): number {
  const lo = now - windowMs;
  let n = 0;
  for (const t of eventTimes) {
    if (t > lo && t <= now) {
      n += 1;
    }
  }
  return n;
}

describe('weighted sliding (DynamoStore model)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps approximation within ~10% of exact sliding for uniform traffic across the window', () => {
    const windowMs = 10_000;
    const tBase = 1_000_000_000_000;
    const eventTimes: number[] = [];
    let state: ReturnType<typeof simulateWeightedIncrement> = null;
    const relErrors: number[] = [];

    for (let i = 0; i < 100; i++) {
      const now = tBase + i * 100;
      vi.setSystemTime(now);
      eventTimes.push(now);
      state = simulateWeightedIncrement(state, now, windowMs, 1);
      const exact = exactSlidingCount(now, windowMs, eventTimes);
      const approx = weightedSlidingCount(
        state.previousCount,
        state.currentCount,
        now,
        windowMs,
        state.currentWindowStart,
      );
      if (exact > 0) {
        relErrors.push(Math.abs(approx - exact) / exact);
      }
    }

    expect(relErrors.length).toBeGreaterThan(0);
    const worst = Math.max(...relErrors);
    expect(worst).toBeLessThanOrEqual(0.105);
  });

  it('attributes usage across previous and current sub-windows after a boundary burst', () => {
    const windowMs = 10_000;
    const t0 = 2_000_000_000_000;
    let state = null as ReturnType<typeof simulateWeightedIncrement>;

    for (let k = 0; k < 40; k++) {
      const now = t0 + k * 50;
      vi.setSystemTime(now);
      state = simulateWeightedIncrement(state, now, windowMs, 1);
    }

    const boundary = fixedWindowBoundaryMs(t0 + 40 * 50, windowMs);
    expect(boundary).toBe(fixedWindowBoundaryMs(t0, windowMs));

    const rolloverAt = boundary + windowMs;
    vi.setSystemTime(rolloverAt);
    state = simulateWeightedIncrement(state, rolloverAt, windowMs, 7);

    expect(state.currentWindowStart).toBe(rolloverAt);
    expect(state.previousCount).toBe(40);
    expect(state.currentCount).toBe(7);

    const nowProbe = rolloverAt + 2500;
    vi.setSystemTime(nowProbe);
    const w = 1 - (nowProbe - rolloverAt) / windowMs;
    expect(w).toBe(0.75);

    const raw = weightedSlidingCount(
      state.previousCount,
      state.currentCount,
      nowProbe,
      windowMs,
      state.currentWindowStart,
    );
    expect(raw).toBeCloseTo(40 * 0.75 + 7, 5);
  });

  it('performs rollover when ADD fails and conditional SET (single window step) succeeds', async () => {
    const windowMs = 10_000;
    const tStart = 3_000_000_000_000;
    const thisBoundary = fixedWindowBoundaryMs(tStart + 50, windowMs);
    const prevBoundary = thisBoundary - windowMs;

    vi.setSystemTime(tStart + 50);

    const send = vi.fn();
    let call = 0;
    send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      const input = command.input;
      call += 1;
      if (call === 1) {
        expect(String(input.UpdateExpression)).toContain('ADD currentCount');
        expect(input.ConditionExpression).toBe('currentWindowStart = :b');
        expect(input.ExpressionAttributeValues).toMatchObject({
          ':b': thisBoundary,
        });
        throw new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        });
      }
      expect(String(input.UpdateExpression)).toContain('SET previousCount = currentCount');
      expect(input.ConditionExpression).toBe('currentWindowStart = :pb');
      expect(input.ExpressionAttributeValues).toMatchObject({
        ':pb': prevBoundary,
        ':b': thisBoundary,
        ':cost': 3,
      });
      return {
        Attributes: {
          pk: 'rlf:k',
          currentWindowStart: thisBoundary,
          currentCount: 3,
          previousCount: 40,
          ttl: 1,
        },
      };
    });

    const store = new DynamoStore({
      client: { send } as never,
      tableName: 'rate_limits',
      windowMs,
      maxRequests: 100,
      strategy: RateLimitStrategy.SLIDING_WINDOW,
    });

    const r = await store.increment('k', { cost: 3 });
    expect(call).toBe(2);
    expect(r.isBlocked).toBe(false);
    expect(r.totalHits).toBe(Math.ceil(40 * (1 - 50 / windowMs) + 3));
  });
});
