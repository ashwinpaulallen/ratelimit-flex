import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../../src/key-manager/admin-router.js';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';

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
  app.use('/admin', createAdminRouter(km));
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

describe('createAdminRouter', () => {
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
    wrapped.use('/admin', createAdminRouter(km));
    await request(wrapped).post('/admin/keys/user-act/block').send({ durationMs: 1000 });
    const audit = km.getAuditLog({ key: 'user-act', action: 'block', limit: 1 });
    expect(audit[0]?.actor).toBe('from-user');
  });
});
