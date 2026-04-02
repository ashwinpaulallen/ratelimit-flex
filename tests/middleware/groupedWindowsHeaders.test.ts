import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { RateLimitStrategy } from '../../src/types/index.js';

/**
 * Supertest lowercases header names; use bracket form for hyphenated names.
 */
function policy(h: Record<string, unknown>): string {
  return String(h['ratelimit-policy'] ?? '');
}

function createApp(opts: Parameters<typeof expressRateLimiter>[0]) {
  const app = express();
  app.use(expressRateLimiter(opts));
  app.get('/ok', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('expressRateLimiter grouped windows + draft-7 headers', () => {
  it('request blocked by hourly window gets headers reflecting the hourly window', async () => {
    /**
     * With limits [{ 60s, 100 }, { 1h, 1000 }], the per-minute slot blocks at the 101st request before
     * the hourly slot can bind. Use a high per-minute cap and a modest hourly cap so we block on the
     * hourly slot without thousands of HTTP round-trips (keeps the suite stable under parallel workers).
     */
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      standardHeaders: 'draft-7',
      limits: [
        { windowMs: 60_000, max: 10_000 },
        { windowMs: 3_600_000, max: 20 },
      ],
    });
    for (let i = 0; i < 20; i++) {
      const r = await request(app).get('/ok');
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(429);
    expect(policy(blocked.headers)).toContain('w=3600');
    expect(policy(blocked.headers)).toContain('20');
    const ra = Number(blocked.headers['retry-after']);
    expect(Number.isFinite(ra)).toBe(true);
    expect(ra).toBeGreaterThanOrEqual(0);
    expect(ra).toBeLessThanOrEqual(3600);
  }, 30_000);

  it(
    'request blocked by per-minute window gets headers reflecting the per-minute window',
    async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      standardHeaders: 'draft-7',
      limits: [
        { windowMs: 60_000, max: 100 },
        { windowMs: 3_600_000, max: 1000 },
      ],
    });
    for (let i = 0; i < 100; i++) {
      const r = await request(app).get('/ok');
      expect(r.status).toBe(200);
    }
    const blocked = await request(app).get('/ok');
    expect(blocked.status).toBe(429);
    expect(policy(blocked.headers)).toContain('w=60');
    expect(policy(blocked.headers)).toContain('100');
    },
    60_000,
  );

  it('request not blocked: headers reflect the most constrained window', async () => {
    const app = createApp({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      standardHeaders: 'draft-7',
      limits: [
        { windowMs: 60_000, max: 100 },
        { windowMs: 3_600_000, max: 1000 },
      ],
    });
    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    // After one allow, minute remaining (99) is lower than hour (999); binding slot is the minute window.
    expect(res.headers['ratelimit-policy']).toBe('100;w=60');
  });
});
