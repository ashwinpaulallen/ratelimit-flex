import express from 'express';
import type { Request, Response, Router } from 'express';
import type { KeyManager } from './KeyManager.js';
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
 * Creates an Express `Router` with admin endpoints for managing rate limit keys.
 *
 * ⚠️ **Security Warning:** These endpoints provide full control over rate limit state.
 * Always mount behind authentication middleware to prevent unauthorized access.
 *
 * @example
 * ```ts
 * import { createAdminRouter } from 'ratelimit-flex';
 * app.use('/admin/ratelimit', authMiddleware, createAdminRouter(keyManager));
 * ```
 * @since 2.2.0
 */
export function createAdminRouter(keyManager: KeyManager): Router {
  const router = express.Router();
  router.use(express.json());

  async function sendResult(res: Response, result: Promise<{ status: number; body: unknown }> | { status: number; body: unknown }): Promise<void> {
    const r = await Promise.resolve(result);
    res.status(r.status).json(r.body);
  }

  router.get('/keys/:key', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const actor = resolveActorFromRequest(req, undefined);
      await sendResult(res, adminGetKey(keyManager, key, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/keys/:key/block', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const body = req.body as { actor?: string } | undefined;
      const actor = resolveActorFromRequest(req, body);
      await sendResult(res, adminPostBlock(keyManager, key, req.body, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/keys/:key/unblock', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const body = req.body as { actor?: string } | undefined;
      const actor = resolveActorFromRequest(req, body);
      await sendResult(res, adminPostUnblock(keyManager, key, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/keys/:key/penalty', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const body = (req.body ?? {}) as { actor?: string };
      const actor = resolveActorFromRequest(req, body);
      await sendResult(res, adminPostPenalty(keyManager, key, req.body ?? {}, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/keys/:key/reward', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const body = (req.body ?? {}) as { actor?: string };
      const actor = resolveActorFromRequest(req, body);
      await sendResult(res, adminPostReward(keyManager, key, req.body ?? {}, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/keys/:key/set', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const body = req.body as { actor?: string } | undefined;
      const actor = resolveActorFromRequest(req, body);
      await sendResult(res, adminPostSet(keyManager, key, req.body, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/keys/:key', async (req: Request, res: Response) => {
    try {
      const key = decodeKeyParam(req.params.key);
      const body = req.body as { actor?: string } | undefined;
      const actor = resolveActorFromRequest(req, body);
      await sendResult(res, adminDeleteKey(keyManager, key, actor));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/blocks', (_req: Request, res: Response) => {
    try {
      const r = adminGetBlocks(keyManager);
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/blocks/clear', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { actor?: string };
      const actor = resolveActorFromRequest(req, body);
      const r = adminPostBlocksClear(keyManager, actor);
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/audit', (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string | string[] | undefined>;
      const r = adminGetAudit(keyManager, q);
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
