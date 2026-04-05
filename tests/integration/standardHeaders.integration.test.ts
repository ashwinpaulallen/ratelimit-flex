import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { expressRateLimiter } from '../../src/middleware/express.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const stores: MemoryStore[] = [];
function trackedStore(options: ConstructorParameters<typeof MemoryStore>[0]) {
  const s = new MemoryStore(options);
  stores.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.shutdown()));
});

function createApp(opts: Parameters<typeof expressRateLimiter>[0]) {
  const app = express();
  app.use(expressRateLimiter(opts));
  app.get('/ok', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

/** Supertest lowercases header names */
function h(headers: Record<string, unknown>, name: string): string | undefined {
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k !== undefined ? String(headers[k]) : undefined;
}

function assertNoRetryAfter(headers: Record<string, unknown>): void {
  expect(h(headers, 'retry-after')).toBeUndefined();
}

function assertEpochReset(value: string): void {
  const n = Number(value);
  expect(Number.isFinite(n)).toBe(true);
  expect(n).toBeGreaterThan(1_600_000_000);
}

function assertSecondsReset(value: string): void {
  const n = Number(value);
  expect(Number.isFinite(n)).toBe(true);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(60);
}

function parseDraft7RateLimit(v: string): { limit: number; remaining: number; reset: number } {
  const m = /^limit=(\d+), remaining=(\d+), reset=(\d+)$/.exec(v);
  expect(m).not.toBeNull();
  return {
    limit: Number(m![1]),
    remaining: Number(m![2]),
    reset: Number(m![3]),
  };
}

function parseDraft8RateLimit(v: string): { id: string; r: number; t: number } {
  const m = /^"([^"]+)";r=(\d+);t=(\d+)$/.exec(v);
  expect(m).not.toBeNull();
  return { id: m![1], r: Number(m![2]), t: Number(m![3]) };
}

function parseDraft8Policy(v: string): { id: string; q: number; w: number } {
  const m = /^"([^"]+)";q=(\d+);w=(\d+)$/.exec(v);
  expect(m).not.toBeNull();
  return { id: m![1], q: Number(m![2]), w: Number(m![3]) };
}

describe('standardHeaders golden integration (Express + supertest)', () => {
  describe('legacy', () => {
    it('200: X-RateLimit-* epoch format, no Retry-After', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'legacy',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      
      // Retry mechanism to handle flaky HTTP parse errors
      let res;
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
        try {
          res = await request(app).get('/ok');
          break;
        } catch (err) {
          attempts++;
          if (attempts >= maxAttempts) throw err;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      expect(res!.status).toBe(200);
      expect(h(res!.headers, 'x-ratelimit-limit')).toBe('10');
      expect(h(res!.headers, 'x-ratelimit-remaining')).toBe('9');
      assertEpochReset(h(res!.headers, 'x-ratelimit-reset')!);
      assertNoRetryAfter(res!.headers);
    });

    it('429: same headers plus Retry-After (seconds)', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        standardHeaders: 'legacy',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      });
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      expect(res.status).toBe(429);
      expect(h(res.headers, 'x-ratelimit-limit')).toBe('1');
      expect(h(res.headers, 'x-ratelimit-remaining')).toBe('0');
      assertEpochReset(h(res.headers, 'x-ratelimit-reset')!);
      const ra = h(res.headers, 'retry-after');
      expect(ra).toBeDefined();
      const sec = Number(ra);
      expect(sec).toBeGreaterThanOrEqual(1);
      expect(sec).toBeLessThanOrEqual(60);
    });
  });

  describe('draft-6', () => {
    it('200: RateLimit-* + RateLimit-Policy; reset is seconds; no Retry-After', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-6',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      const res = await request(app).get('/ok');
      expect(res.status).toBe(200);
      expect(h(res.headers, 'ratelimit-limit')).toBe('10');
      expect(h(res.headers, 'ratelimit-remaining')).toBe('9');
      expect(h(res.headers, 'ratelimit-policy')).toBe('10;w=60');
      assertSecondsReset(h(res.headers, 'ratelimit-reset')!);
      assertNoRetryAfter(res.headers);
    });

    it('429: includes Retry-After matching RateLimit-Reset (seconds)', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        standardHeaders: 'draft-6',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      });
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      expect(res.status).toBe(429);
      expect(h(res.headers, 'ratelimit-policy')).toBe('1;w=60');
      const sur = h(res.headers, 'ratelimit-reset')!;
      const ra = h(res.headers, 'retry-after')!;
      expect(sur).toBe(ra);
      assertSecondsReset(sur);
    });
  });

  describe('draft-7', () => {
    it('200: combined RateLimit + RateLimit-Policy; no Retry-After', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-7',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      const res = await request(app).get('/ok');
      expect(res.status).toBe(200);
      expect(h(res.headers, 'ratelimit-policy')).toBe('10;w=60');
      const combined = h(res.headers, 'ratelimit')!;
      expect(combined).toMatch(/^limit=10, remaining=9, reset=\d+$/);
      assertNoRetryAfter(res.headers);
    });

    it('429: Retry-After matches reset seconds in RateLimit line', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        standardHeaders: 'draft-7',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      });
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      expect(res.status).toBe(429);
      const parsed = parseDraft7RateLimit(h(res.headers, 'ratelimit')!);
      expect(parsed.limit).toBe(1);
      expect(parsed.remaining).toBe(0);
      assertSecondsReset(String(parsed.reset));
      expect(h(res.headers, 'retry-after')).toBe(String(parsed.reset));
    });
  });

  describe('draft-8', () => {
    it('200: named RateLimit + RateLimit-Policy; no Retry-After', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-8',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      const res = await request(app).get('/ok');
      expect(res.status).toBe(200);
      expect(h(res.headers, 'ratelimit-policy')).toBe('"10-per-60";q=10;w=60');
      const rl = h(res.headers, 'ratelimit')!;
      expect(rl).toMatch(/^"10-per-60";r=9;t=\d+$/);
      const p = parseDraft8RateLimit(rl);
      expect(p.id).toBe('10-per-60');
      assertSecondsReset(String(p.t));
      assertNoRetryAfter(res.headers);
    });

    it('429: Retry-After equals t in RateLimit', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 1,
        standardHeaders: 'draft-8',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 1,
        }),
      });
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      expect(res.status).toBe(429);
      const rl = h(res.headers, 'ratelimit')!;
      const p = parseDraft8RateLimit(rl);
      expect(h(res.headers, 'retry-after')).toBe(String(p.t));
    });
  });

  describe('header value correctness (3rd of 10 requests)', () => {
    const formats = ['legacy', 'draft-6', 'draft-7', 'draft-8'] as const;

    it.each(formats)('%s: limit 10, remaining 7, reset semantics', async (format) => {
      const store = trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: format,
        store,
      });
      await request(app).get('/ok');
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      expect(res.status).toBe(200);

      if (format === 'legacy') {
        expect(h(res.headers, 'x-ratelimit-limit')).toBe('10');
        expect(h(res.headers, 'x-ratelimit-remaining')).toBe('7');
        assertEpochReset(h(res.headers, 'x-ratelimit-reset')!);
      } else if (format === 'draft-6') {
        expect(h(res.headers, 'ratelimit-limit')).toBe('10');
        expect(h(res.headers, 'ratelimit-remaining')).toBe('7');
        expect(h(res.headers, 'ratelimit-policy')).toBe('10;w=60');
        assertSecondsReset(h(res.headers, 'ratelimit-reset')!);
      } else if (format === 'draft-7') {
        const combined = h(res.headers, 'ratelimit')!;
        const p = parseDraft7RateLimit(combined);
        expect(p.limit).toBe(10);
        expect(p.remaining).toBe(7);
        assertSecondsReset(String(p.reset));
        expect(h(res.headers, 'ratelimit-policy')).toBe('10;w=60');
      } else {
        expect(h(res.headers, 'ratelimit-policy')).toBe('"10-per-60";q=10;w=60');
        const rl = h(res.headers, 'ratelimit')!;
        const p = parseDraft8RateLimit(rl);
        expect(p.id).toBe('10-per-60');
        expect(p.r).toBe(7);
        assertSecondsReset(String(p.t));
      }
      assertNoRetryAfter(res.headers);
    });
  });

  describe('draft-7 combined line (explicit)', () => {
    it('RateLimit matches limit=10, remaining=7, reset=XX', async () => {
      const store = trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-7',
        store,
      });
      await request(app).get('/ok');
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      const v = h(res.headers, 'ratelimit')!;
      expect(v).toMatch(/^limit=10, remaining=7, reset=\d+$/);
      const p = parseDraft7RateLimit(v);
      expect(p.limit).toBe(10);
      expect(p.remaining).toBe(7);
      expect(p.reset).toBeGreaterThan(0);
      expect(p.reset).toBeLessThanOrEqual(60);
    });
  });

  describe('draft-8 named policy (explicit)', () => {
    it('RateLimit and RateLimit-Policy match default identifier 10-per-60', async () => {
      const store = trackedStore({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
      });
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-8',
        store,
      });
      await request(app).get('/ok');
      await request(app).get('/ok');
      const res = await request(app).get('/ok');
      expect(h(res.headers, 'ratelimit-policy')).toBe('"10-per-60";q=10;w=60');
      const rl = h(res.headers, 'ratelimit')!;
      expect(rl).toMatch(/^"10-per-60";r=7;t=\d+$/);
      const pr = parseDraft8RateLimit(rl);
      expect(pr).toMatchObject({ id: '10-per-60', r: 7 });
      const pol = parseDraft8Policy(h(res.headers, 'ratelimit-policy')!);
      expect(pol).toMatchObject({ id: '10-per-60', q: 10, w: 60 });
    });
  });

  describe('draft-8 custom identifier', () => {
    it('RateLimit and RateLimit-Policy contain my-api', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-8',
        identifier: 'my-api',
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      const res = await request(app).get('/ok');
      expect(h(res.headers, 'ratelimit-policy')).toContain('"my-api"');
      expect(h(res.headers, 'ratelimit')).toContain('"my-api"');
    });
  });

  describe('draft-6 + legacyHeaders: true', () => {
    it('exposes both RateLimit-Remaining and X-RateLimit-Remaining', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: 'draft-6',
        legacyHeaders: true,
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      const res = await request(app).get('/ok');
      expect(res.status).toBe(200);
      expect(h(res.headers, 'ratelimit-remaining')).toBe('9');
      expect(h(res.headers, 'x-ratelimit-remaining')).toBe('9');
    });
  });

  describe('standardHeaders: false', () => {
    it('sends no rate-limit-related headers', async () => {
      const app = createApp({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        standardHeaders: false,
        store: trackedStore({
          strategy: RateLimitStrategy.SLIDING_WINDOW,
          windowMs: 60_000,
          maxRequests: 10,
        }),
      });
      const res = await request(app).get('/ok');
      expect(res.status).toBe(200);
      const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
      const rateKeys = keys.filter(
        (k) =>
          k.includes('ratelimit') ||
          k === 'retry-after' ||
          (k.startsWith('x-') && k.includes('rate')),
      );
      expect(rateKeys).toEqual([]);
    });
  });
});
