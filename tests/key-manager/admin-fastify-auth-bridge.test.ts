import Fastify from 'fastify';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { createFastifyAdminAuthHandler } from '../../src/key-manager/admin-auth.js';

/**
 * {@link createFastifyAdminAuthHandler} wraps the same `resolveAdminAuth` middleware as Express,
 * but runs it with a bridged Express-shaped `res` on Fastify. These tests ensure `onAuthFailure`
 * is invoked for credential failures and can send a response through the bridge (same path as
 * the `sendUnauthorized` branch in `admin-auth-middleware`).
 */
describe('createFastifyAdminAuthHandler + onAuthFailure', () => {
  const bearerSecret = '0123456789abcdef0123456789abcdef';

  it('bearer: onAuthFailure runs with Fastify-shaped req and bridged res; success still reaches route', async () => {
    const app = Fastify();
    const reqSnapshots: Array<{ url?: string; hasExpressPath: boolean }> = [];

    const authenticate = createFastifyAdminAuthHandler({
      auth: { type: 'bearer', token: bearerSecret },
      onAuthFailure: (req: Request, res: Response) => {
        reqSnapshots.push({
          url: (req as unknown as { url?: string }).url,
          hasExpressPath: typeof (req as { path?: string }).path === 'string',
        });
        res.status(403).json({ error: 'custom-auth-failure' });
      },
    });

    app.addHook('preHandler', async (request, reply) => {
      await authenticate(request, reply);
    });
    app.get('/probe', async () => ({ ok: true }));

    await app.ready();

    const unauthorized = await app.inject({ method: 'GET', url: '/probe' });
    expect(unauthorized.statusCode).toBe(403);
    expect(JSON.parse(unauthorized.body)).toEqual({ error: 'custom-auth-failure' });
    expect(unauthorized.headers['www-authenticate']).toBeUndefined();

    expect(reqSnapshots).toHaveLength(1);
    expect(reqSnapshots[0]?.url).toBe('/probe');
    expect(reqSnapshots[0]?.hasExpressPath).toBe(false);

    const ok = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: `Bearer ${bearerSecret}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });

    await app.close();
  });

  it('basic: onAuthFailure is used for missing credentials', async () => {
    const app = Fastify();

    const authenticate = createFastifyAdminAuthHandler({
      auth: { type: 'basic', username: 'admin', password: 's3cret' },
      onAuthFailure: (_req, res) => {
        res.status(418).json({ error: 'teapot-auth' });
      },
    });

    app.addHook('preHandler', async (request, reply) => {
      await authenticate(request, reply);
    });
    app.get('/x', async () => 'ok');

    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(418);
    expect(JSON.parse(res.body)).toEqual({ error: 'teapot-auth' });

    await app.close();
  });
});
