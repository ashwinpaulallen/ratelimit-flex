import express from 'express';
import Fastify from 'fastify';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthRequiredError, type AdminRouterOptions } from '../../src/key-manager/admin-auth.js';
import { createAdminRouter } from '../../src/key-manager/admin.js';
import { createFastifyAdminPlugin as fastifyAdminPlugin } from '../../src/key-manager/admin-fastify.js';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const testAdminAuth = { type: 'unsafe-no-auth' as const, acknowledgeRisk: true as const };

function setup() {
  const store = new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 10,
  });
  const km = new KeyManager({
    store,
    maxRequests: 10,
    windowMs: 60_000,
    maxAuditLogSize: 500,
    blockExpiryCheckIntervalMs: 100,
  });
  const app = express();
  app.use('/admin', createAdminRouter(km, { auth: testAdminAuth }));
  return { app, km, store };
}

const suites: { km: KeyManager; store: MemoryStore }[] = [];
function track(km: KeyManager, store: MemoryStore) {
  suites.push({ km, store });
}

afterEach(async () => {
  for (const { km, store } of suites.splice(0)) {
    km.destroy();
    await store.shutdown();
  }
});

function createKeyManagerSuite() {
  const store = new MemoryStore({
    strategy: RateLimitStrategy.SLIDING_WINDOW,
    windowMs: 60_000,
    maxRequests: 10,
  });
  const km = new KeyManager({
    store,
    maxRequests: 10,
    windowMs: 60_000,
    maxAuditLogSize: 500,
    blockExpiryCheckIntervalMs: 100,
  });
  return { km, store };
}

describe('createAdminRouter', () => {
  it('throws AdminAuthRequiredError when auth is omitted', () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    expect(() => createAdminRouter(km, {} as AdminRouterOptions)).toThrow(AdminAuthRequiredError);
  });

  it('accepts minimal bearer auth { type: "bearer", token: "x" }', async () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const app = express();
    app.use('/admin', createAdminRouter(km, { auth: { type: 'bearer', token: 'x' } }));
    await store.increment('p', { cost: 1 });
    const res = await request(app).get('/admin/keys/p').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
  });

  it('writes a security warning to stderr for unsafe-no-auth', () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createAdminRouter(km, { auth: { type: 'unsafe-no-auth', acknowledgeRisk: true } });
      expect(spy).toHaveBeenCalled();
      const first = String(spy.mock.calls[0]?.[0] ?? '');
      expect(first).toContain('unsafe-no-auth');
      expect(first).toContain('[ratelimit-flex] WARNING');
    } finally {
      spy.mockRestore();
    }
  });

  it('Express POST /keys/:key/block: 200 with bearer, 401 wrong or missing token', async () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const app = express();
    app.use('/admin', createAdminRouter(km, { auth: { type: 'bearer', token: 'secret' } }));

    const ok = await request(app)
      .post('/admin/keys/foo/block')
      .set('Authorization', 'Bearer secret')
      .send({ durationMs: 60_000, reason: { type: 'manual' } });
    expect(ok.status).toBe(200);

    const wrong = await request(app)
      .post('/admin/keys/foo/block')
      .set('Authorization', 'Bearer nope')
      .send({ durationMs: 60_000, reason: { type: 'manual' } });
    expect(wrong.status).toBe(401);

    const missing = await request(app).post('/admin/keys/foo/block').send({ durationMs: 60_000, reason: { type: 'manual' } });
    expect(missing.status).toBe(401);
  });

  it('onAdminAction fires on successful admin responses and not on 401', async () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const actions: { method: string }[] = [];
    const app = express();
    app.use(
      '/admin',
      createAdminRouter(km, {
        auth: { type: 'bearer', token: 'tok' },
        onAdminAction: (a) => {
          actions.push({ method: a.method });
        },
      }),
    );

    await request(app)
      .post('/admin/keys/act/block')
      .set('Authorization', 'Bearer tok')
      .send({ durationMs: 1000, reason: { type: 'manual' } });
    expect(actions.length).toBe(1);

    await request(app).post('/admin/keys/act/block').send({ durationMs: 1000, reason: { type: 'manual' } });
    expect(actions.length).toBe(1);
  });

  it('returns 401 when bearer token is missing or wrong', async () => {
    const store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    const km = new KeyManager({
      store,
      maxRequests: 10,
      windowMs: 60_000,
      maxAuditLogSize: 500,
      blockExpiryCheckIntervalMs: 100,
    });
    track(km, store);
    const app = express();
    app.use('/admin', createAdminRouter(km, { auth: { type: 'bearer', token: 'secret' } }));

    const missing = await request(app).get('/admin/keys/x');
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('Unauthorized');

    const wrong = await request(app).get('/admin/keys/x').set('Authorization', 'Bearer wrong');
    expect(wrong.status).toBe(401);

    await store.increment('ok', { cost: 1 });
    const ok = await request(app).get('/admin/keys/ok').set('Authorization', 'Bearer secret');
    expect(ok.status).toBe(200);
  });

  it('GET /keys/:key returns state', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await store.increment('alice', { cost: 2 });
    const res = await request(app).get('/admin/keys/alice');
    expect(res.status).toBe(200);
    expect(res.body.state).toBeDefined();
    expect(res.body.state.key).toBe('alice');
    expect(res.body.state.totalHits).toBe(2);
  });

  it('GET /keys/:key returns 404 for unknown key', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app).get('/admin/keys/unknown');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('POST /keys/:key/block blocks and returns state', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app)
      .post('/admin/keys/bob/block')
      .send({ durationMs: 60_000, reason: { type: 'manual', message: 'abuse' }, actor: 'ops' });
    expect(res.status).toBe(200);
    expect(res.body.state.isBlocked).toBe(true);
    expect(km.isBlocked('bob')).toBe(true);
  });

  it('POST /keys/:key/unblock unblocks', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await km.block('c', 10_000, { type: 'manual' });
    const res = await request(app).post('/admin/keys/c/unblock').send({});
    expect(res.status).toBe(200);
    expect(km.isBlocked('c')).toBe(false);
  });

  it('POST /keys/:key/unblock returns 404 when not blocked', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await store.increment('d', { cost: 1 });
    const res = await request(app).post('/admin/keys/d/unblock').send({});
    expect(res.status).toBe(404);
  });

  it('POST /keys/:key/penalty adds penalty', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app).post('/admin/keys/e/penalty').send({ points: 3 });
    expect(res.status).toBe(200);
    expect(res.body.state.penaltyPoints).toBe(3);
  });

  it('POST /keys/:key/reward adds reward', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await store.increment('f', { cost: 5 });
    const res = await request(app).post('/admin/keys/f/reward').send({ points: 2 });
    expect(res.status).toBe(200);
    expect(res.body.state.rewardPoints).toBe(2);
  });

  it('POST /keys/:key/set sets hits', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app)
      .post('/admin/keys/g/set')
      .send({ totalHits: 4, expiresAt: new Date('2026-12-01T00:00:00.000Z').toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.state.totalHits).toBe(4);
  });

  it('DELETE /keys/:key deletes', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await store.increment('h', { cost: 1 });
    const res = await request(app).delete('/admin/keys/h');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(await km.get('h')).toBeNull();
  });

  it('DELETE /keys/:key returns 404 when nothing to delete', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app).delete('/admin/keys/nope');
    expect(res.status).toBe(404);
  });

  it('GET /blocks returns all blocked keys', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await km.block('i1', 10_000, { type: 'manual' });
    await km.block('i2', 10_000, { type: 'abuse-pattern', pattern: 'x' });
    const res = await request(app).get('/admin/blocks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const keys = (res.body as { key: string }[]).map((r) => r.key).sort();
    expect(keys).toEqual(['i1', 'i2']);
  });

  it('POST /blocks/clear clears all', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await km.block('j1', 10_000, { type: 'manual' });
    await km.block('j2', 10_000, { type: 'manual' });
    const res = await request(app).post('/admin/blocks/clear').send({ actor: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    expect(km.getBlockedKeys().length).toBe(0);
  });

  it('GET /audit returns filtered entries', async () => {
    const { app, km, store } = setup();
    track(km, store);
    await request(app).get('/admin/keys/audit-key');
    await request(app).post('/admin/keys/audit-key/block').send({ durationMs: 5000 });
    const res = await request(app).get('/admin/audit').query({ key: 'audit-key', limit: 10 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as { key: string }[]).every((e) => e.key === 'audit-key')).toBe(true);
  });

  it('returns 400 for invalid block body', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app).post('/admin/keys/z/block').send({ foo: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid audit query', async () => {
    const { app, km, store } = setup();
    track(km, store);
    const res = await request(app).get('/admin/audit').query({ action: 'not-a-real-action' });
    expect(res.status).toBe(400);
  });

  it('uses req.user for actor when body omitted', async () => {
    const { km, store } = setup();
    track(km, store);
    const wrapped = express();
    wrapped.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string } }).user = { id: 'from-user' };
      next();
    });
    wrapped.use('/admin', createAdminRouter(km, { auth: testAdminAuth }));
    await request(wrapped).post('/admin/keys/user-act/block').send({ durationMs: 1000 });
    const audit = km.getAuditLog({ key: 'user-act', action: 'block', limit: 1 });
    expect(audit[0]?.actor).toBe('from-user');
  });
});

describe('fastifyAdminPlugin', () => {
  it('throws AdminAuthRequiredError when options omit auth', async () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const app = Fastify();
    await expect(
      app.register(fastifyAdminPlugin, { keyManager: km, options: {} as AdminRouterOptions }),
    ).rejects.toThrow(AdminAuthRequiredError);
  });

  it('POST /keys/:key/block: 200 with bearer, 401 wrong or missing token', async () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const app = Fastify();
    await app.register(fastifyAdminPlugin, {
      keyManager: km,
      options: { auth: { type: 'bearer', token: 'secret' } },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/keys/foo/block',
      headers: { authorization: 'Bearer secret' },
      payload: { durationMs: 60_000, reason: { type: 'manual' } },
    });
    expect(ok.statusCode).toBe(200);

    const wrong = await app.inject({
      method: 'POST',
      url: '/keys/foo/block',
      headers: { authorization: 'Bearer wrong' },
      payload: { durationMs: 60_000, reason: { type: 'manual' } },
    });
    expect(wrong.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'POST',
      url: '/keys/foo/block',
      payload: { durationMs: 60_000, reason: { type: 'manual' } },
    });
    expect(missing.statusCode).toBe(401);
  });

  it('onAdminAction fires on success and not on 401', async () => {
    const { km, store } = createKeyManagerSuite();
    track(km, store);
    const actions: unknown[] = [];
    const app = Fastify();
    await app.register(fastifyAdminPlugin, {
      keyManager: km,
      options: {
        auth: { type: 'bearer', token: 'tok' },
        onAdminAction: (a) => {
          actions.push(a);
        },
      },
    });

    await app.inject({
      method: 'POST',
      url: '/keys/f/block',
      headers: { authorization: 'Bearer tok' },
      payload: { durationMs: 1000, reason: { type: 'manual' } },
    });
    expect(actions.length).toBe(1);

    await app.inject({
      method: 'POST',
      url: '/keys/f/block',
      payload: { durationMs: 1000, reason: { type: 'manual' } },
    });
    expect(actions.length).toBe(1);
  });
});
