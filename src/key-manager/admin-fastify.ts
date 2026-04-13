import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { KeyManager } from './KeyManager.js';
import {
  AdminAuthRequiredError,
  authenticateFastifyRequest,
  extractAdminKeyFromPath,
  type AdminRouterOptions,
} from './admin-auth.js';
import {
  adminDeleteKey,
  adminGetAudit,
  adminGetBlocks,
  adminGetKey,
  adminPostBlock,
  adminPostBlocksClear,
  adminPostPenalty,
  adminPostReward,
  adminPostSet,
  adminPostUnblock,
  decodeKeyParam,
  resolveActorFromRequest,
} from './admin-common.js';

/**
 * Options for {@link createFastifyAdminPlugin} / {@link fastifyAdminPlugin}.
 *
 * `options` must include {@link AdminRouterOptions.auth} — there is no default.
 */
export interface FastifyAdminPluginOptions {
  keyManager: KeyManager;
  options: AdminRouterOptions;
  /** Route prefix (e.g. `/admin/ratelimit`). No trailing slash. */
  prefix?: string;
}

const adminPluginImpl: FastifyPluginAsync<FastifyAdminPluginOptions> = async (fastify, pluginOpts) => {
  const opts = pluginOpts.options;
  if (!opts || !opts.auth) {
    throw new AdminAuthRequiredError();
  }

  if (opts.auth.type === 'unsafe-no-auth') {
    process.stderr.write(
      '[ratelimit-flex] WARNING: KeyManager admin router mounted with ' +
        '`unsafe-no-auth`. This exposes block/unblock/reward endpoints ' +
        'without authentication. Use only for development and tests. ' +
        'For production, use { type: "bearer" | "basic" | "middleware" }.\n',
    );
  }

  fastify.addHook('preHandler', async (request, reply) => {
    await authenticateFastifyRequest(request, reply, opts);
  });

  const { onAdminAction } = opts;
  if (onAdminAction) {
    fastify.addHook('onResponse', (request, reply, done) => {
      try {
        const code = reply.statusCode;
        if (code >= 200 && code < 400) {
          const path = request.url.split('?')[0] ?? '';
          onAdminAction({
            method: request.method,
            path,
            key: extractAdminKeyFromPath(path),
            actor: resolveActorFromRequest(
              request as FastifyRequest & { body?: unknown; user?: unknown },
              request.body as { actor?: string } | undefined,
            ),
            timestamp: new Date(),
          });
        }
      } finally {
        done();
      }
    });
  }

  const km = pluginOpts.keyManager;
  const prefix = pluginOpts.prefix ?? '';

  async function run(
    reply: FastifyReply,
    result: Promise<{ status: number; body: unknown }> | { status: number; body: unknown },
  ): Promise<void> {
    const r = await Promise.resolve(result);
    await reply.status(r.status).send(r.body);
  }

  fastify.get(`${prefix}/keys/:key`, async (request: FastifyRequest<{ Params: { key: string } }>, reply) => {
    const key = decodeKeyParam(request.params.key);
    const actor = resolveActorFromRequest(request, undefined);
    await run(reply, adminGetKey(km, key, actor));
  });

  fastify.post(`${prefix}/keys/:key/block`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const key = decodeKeyParam((request.params as { key: string }).key);
    const body = request.body as { actor?: string } | undefined;
    const actor = resolveActorFromRequest(request, body);
    await run(reply, adminPostBlock(km, key, request.body, actor));
  });

  fastify.post(`${prefix}/keys/:key/unblock`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const key = decodeKeyParam((request.params as { key: string }).key);
    const body = request.body as { actor?: string } | undefined;
    const actor = resolveActorFromRequest(request, body);
    await run(reply, adminPostUnblock(km, key, actor));
  });

  fastify.post(`${prefix}/keys/:key/penalty`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const key = decodeKeyParam((request.params as { key: string }).key);
    const body = (request.body ?? {}) as { actor?: string };
    const actor = resolveActorFromRequest(request, body);
    await run(reply, adminPostPenalty(km, key, request.body ?? {}, actor));
  });

  fastify.post(`${prefix}/keys/:key/reward`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const key = decodeKeyParam((request.params as { key: string }).key);
    const body = (request.body ?? {}) as { actor?: string };
    const actor = resolveActorFromRequest(request, body);
    await run(reply, adminPostReward(km, key, request.body ?? {}, actor));
  });

  fastify.post(`${prefix}/keys/:key/set`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const key = decodeKeyParam((request.params as { key: string }).key);
    const body = request.body as { actor?: string } | undefined;
    const actor = resolveActorFromRequest(request, body);
    await run(reply, adminPostSet(km, key, request.body, actor));
  });

  fastify.delete(`${prefix}/keys/:key`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const key = decodeKeyParam((request.params as { key: string }).key);
    const body = request.body as { actor?: string } | undefined;
    const actor = resolveActorFromRequest(request, body);
    await run(reply, adminDeleteKey(km, key, actor));
  });

  fastify.get(`${prefix}/blocks`, async (_request, reply) => {
    const r = adminGetBlocks(km);
    await reply.status(r.status).send(r.body);
  });

  fastify.post(`${prefix}/blocks/clear`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const body = (request.body ?? {}) as { actor?: string };
    const actor = resolveActorFromRequest(request, body);
    const r = adminPostBlocksClear(km, actor);
    await reply.status(r.status).send(r.body);
  });

  fastify.get(`${prefix}/audit`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>;
    const r = adminGetAudit(km, q);
    await reply.status(r.status).send(r.body);
  });
};

/**
 * Fastify plugin registering the same admin routes as {@link createAdminRouter}.
 *
 * ⚠️ **Security Warning:** These endpoints provide full control over rate limit state.
 * You must pass `options.auth` on {@link FastifyAdminPluginOptions} — use bearer, basic, or middleware in production.
 *
 * @example
 * ```ts
 * await app.register(createFastifyAdminPlugin, {
 *   prefix: '/admin/ratelimit',
 *   keyManager: limiter.keyManager!,
 *   options: { auth: { type: 'bearer', token: process.env.ADMIN_TOKEN! } },
 * });
 * ```
 * @since 2.2.0
 */
export const createFastifyAdminPlugin = fp(adminPluginImpl, {
  name: 'ratelimit-flex-key-manager-admin',
});
