import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { webSocketLimiter } from '../../src/hono/webSocketLimiter.js';

describe('webSocketLimiter (Hono)', () => {
  it('allows the request through to the next handler when under the limit', async () => {
    const app = new Hono();
    app.get(
      '/ws',
      webSocketLimiter({
        maxRequests: 5,
        windowMs: 60_000,
        keyGenerator: () => 'ws-client-1',
        standardHeaders: false,
      }),
      (c) => c.text('would-upgrade'),
    );

    const res = await app.request('http://test/ws');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('would-upgrade');
  });

  it('returns 429 before the next handler when over the limit', async () => {
    let nextCalls = 0;
    const app = new Hono();
    app.get(
      '/ws',
      webSocketLimiter({
        maxRequests: 2,
        windowMs: 60_000,
        keyGenerator: () => 'ws-client-2',
        standardHeaders: false,
      }),
      (c) => {
        nextCalls += 1;
        return c.text('would-upgrade');
      },
    );

    const h = { 'x-forwarded-for': '10.0.0.1' };
    expect((await app.request('http://test/ws', { headers: h })).status).toBe(200);
    expect((await app.request('http://test/ws', { headers: h })).status).toBe(200);
    expect(nextCalls).toBe(2);

    const blocked = await app.request('http://test/ws', { headers: h });
    expect(blocked.status).toBe(429);
    expect(nextCalls).toBe(2);
    const body = (await blocked.json()) as { error?: string };
    expect(body.error).toBe('Too many requests');
  });
});
