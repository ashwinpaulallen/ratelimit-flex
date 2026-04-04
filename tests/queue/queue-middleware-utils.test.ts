import { describe, expect, it } from 'vitest';

import { RateLimiterQueueError } from '../../src/queue/RateLimiterQueue.js';
import { resolveCost, retryAfterSeconds } from '../../src/queue/queue-middleware-utils.js';

describe('queue-middleware-utils', () => {
  describe('resolveCost', () => {
    it('returns sanitized static cost', () => {
      expect(resolveCost({}, 5)).toBe(5);
      expect(resolveCost({}, 1)).toBe(1);
    });

    it('returns default 1 when cost is undefined', () => {
      expect(resolveCost({}, undefined)).toBe(1);
    });

    it('sanitizes invalid static costs to 1', () => {
      expect(resolveCost({}, 0)).toBe(1);
      expect(resolveCost({}, -5)).toBe(1);
      expect(resolveCost({}, NaN)).toBe(1);
    });

    it('calls function and sanitizes result', () => {
      const fn = (req: unknown) => (req as { weight?: number }).weight ?? 3;
      expect(resolveCost({ weight: 10 }, fn)).toBe(10);
      expect(resolveCost({}, fn)).toBe(3);
    });

    it('sanitizes invalid function results to 1', () => {
      const badFn = () => -1;
      expect(resolveCost({}, badFn)).toBe(1);
    });
  });

  describe('retryAfterSeconds', () => {
    it('returns ceil(maxQueueTimeMs / 1000) for queue_timeout errors', () => {
      const err = new RateLimiterQueueError('Queue timeout exceeded', 'queue_timeout');
      expect(retryAfterSeconds(err, 5000)).toBe(5);
      expect(retryAfterSeconds(err, 12_000)).toBe(12);
      expect(retryAfterSeconds(err, 1500)).toBe(2); // ceil(1.5) = 2
    });

    it('returns minimum 1 second for queue_timeout', () => {
      const err = new RateLimiterQueueError('Queue timeout exceeded', 'queue_timeout');
      expect(retryAfterSeconds(err, 100)).toBe(1); // ceil(0.1) = 1, then max(1, 1) = 1
      expect(retryAfterSeconds(err, 0)).toBe(1);
    });

    it('returns 1 second for queue_full errors', () => {
      const err = new RateLimiterQueueError('Queue is full', 'queue_full');
      expect(retryAfterSeconds(err, 30_000)).toBe(1);
    });

    it('returns 1 second for queue_shutdown errors', () => {
      const err = new RateLimiterQueueError('Queue shut down', 'queue_shutdown');
      expect(retryAfterSeconds(err, 30_000)).toBe(1);
    });

    it('returns 1 second for queue_cleared errors', () => {
      const err = new RateLimiterQueueError('Queue cleared', 'queue_cleared');
      expect(retryAfterSeconds(err, 30_000)).toBe(1);
    });

    it('returns 1 second for cost_exceeds_limit errors', () => {
      const err = new RateLimiterQueueError('Cost exceeds limit', 'cost_exceeds_limit');
      expect(retryAfterSeconds(err, 30_000)).toBe(1);
    });

    it('is robust against message changes (uses code, not message)', () => {
      const err1 = new RateLimiterQueueError('Timeout!', 'queue_timeout');
      const err2 = new RateLimiterQueueError('Request timed out', 'queue_timeout');
      const err3 = new RateLimiterQueueError('Queue timeout exceeded', 'queue_timeout');

      expect(retryAfterSeconds(err1, 8000)).toBe(8);
      expect(retryAfterSeconds(err2, 8000)).toBe(8);
      expect(retryAfterSeconds(err3, 8000)).toBe(8);
    });
  });
});
