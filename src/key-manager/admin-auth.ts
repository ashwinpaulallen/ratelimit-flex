import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { resolveAdminAuth } from './admin-auth-middleware.js';
import { resolveActorFromRequest } from './admin-common.js';

/**
 * Authentication mode for the KeyManager admin HTTP API.
 *
 * The admin API exposes block/unblock/reward/delete endpoints. In production,
 * these routes MUST be authenticated — they let callers modify the state of
 * every rate-limited key in the system. Unauthenticated admin routes have
 * been the root cause of real CVEs in similar libraries.
 *
 * This type is a discriminated union so that TypeScript forces every caller
 * to make an explicit choice between a real auth strategy and the unsafe
 * escape hatch. There is no "default" — omitting `auth` at construction time
 * is a compile error.
 */
export type AdminAuthMode =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'middleware'; handler: AdminAuthMiddleware }
  | { type: 'unsafe-no-auth'; acknowledgeRisk: true };

/**
 * Custom auth middleware signature. Compatible with Express middleware;
 * the Fastify adapter wraps this to the Fastify request/reply shape.
 *
 * Return / call next() to allow the request. Respond with 401/403 to reject.
 */
export type AdminAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/**
 * Options for createAdminRouter / createFastifyAdminPlugin.
 *
 * `auth` is REQUIRED. Construct-time error if omitted.
 */
export interface AdminRouterOptions {
  /**
   * Authentication strategy. Required — no default.
   *
   * For production, use 'bearer', 'basic', or 'middleware'.
   * 'unsafe-no-auth' is permitted for development/tests only and logs a
   * prominent warning at construction time.
   */
  auth: AdminAuthMode;

  /**
   * Optional custom error handler for auth failures. Default: 401 with
   * { error: 'Unauthorized' }.
   */
  onAuthFailure?: (req: Request, res: Response) => void;

  /**
   * Audit log callback fired on every admin action (after auth succeeds).
   * Useful for security monitoring and compliance.
   */
  onAdminAction?: (action: {
    method: string;
    path: string;
    key?: string;
    actor?: string; // from req.user, req.authInfo, or custom extraction
    timestamp: Date;
  }) => void;
}

/**
 * Error thrown when the admin router is constructed without auth.
 */
export class AdminAuthRequiredError extends Error {
  constructor() {
    super(
      'KeyManager admin router requires the `auth` option. ' +
        'Pass one of: ' +
        '{ type: "bearer", token }, ' +
        '{ type: "basic", username, password }, ' +
        '{ type: "middleware", handler }, ' +
        'or { type: "unsafe-no-auth", acknowledgeRisk: true } for development only. ' +
        'See https://github.com/ashwinpaulallen/ratelimit-flex#admin-api-security for details.',
    );
    this.name = 'AdminAuthRequiredError';
  }
}

const UNSAFE_NO_AUTH_WARNING =
  '[ratelimit-flex] KeyManager admin HTTP API is registered with auth mode "unsafe-no-auth". ' +
    'Anyone who can reach these routes can modify every rate-limited key. Use bearer, basic, or middleware auth in production.';

export function warnUnsafeNoAuthIfNeeded(auth: AdminAuthMode): void {
  if (auth.type === 'unsafe-no-auth') {
    console.warn(UNSAFE_NO_AUTH_WARNING);
  }
}

export function assertAdminRouterOptions(
  options: AdminRouterOptions | undefined | null,
): asserts options is AdminRouterOptions {
  if (options == null || options.auth === undefined) {
    throw new AdminAuthRequiredError();
  }
}

export function extractAdminKeyFromPath(path: string): string | undefined {
  const m = path.match(/\/keys\/([^/]+)/);
  if (!m?.[1]) {
    return undefined;
  }
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * When {@link AdminRouterOptions.onAuthFailure} is set, intercept the built-in
 * 401 response (`res.end` after `statusCode = 401`) so the custom handler runs instead.
 */
function wrapWithCustomAuthFailure(
  core: AdminAuthMiddleware,
  onFailure: (req: Request, res: Response) => void,
): AdminAuthMiddleware {
  return (req: Request, res: Response, next: NextFunction) => {
    const prevEnd = res.end.bind(res);
    let delegated401 = false;

    res.end = ((...args: Parameters<typeof res.end>) => {
      if (res.statusCode === 401 && !delegated401) {
        delegated401 = true;
        res.end = prevEnd;
        onFailure(req, res);
        return res;
      }
      return prevEnd(...args);
    }) as typeof res.end;

    const wrapNext: NextFunction = (err?: unknown) => {
      if (!delegated401) {
        res.end = prevEnd;
      }
      next(err);
    };

    try {
      const out = core(req, res, wrapNext);
      if (out !== undefined && typeof (out as Promise<void>).then === 'function') {
        void (out as Promise<void>).finally(() => {
          if (!delegated401) {
            res.end = prevEnd;
          }
        });
      } else if (!res.headersSent && !delegated401) {
        res.end = prevEnd;
      }
    } catch (e) {
      if (!delegated401) {
        res.end = prevEnd;
      }
      throw e;
    }
  };
}

export function createExpressAdminAuthMiddleware(options: AdminRouterOptions): RequestHandler {
  let core = resolveAdminAuth(options.auth);
  if (options.onAuthFailure) {
    core = wrapWithCustomAuthFailure(core, options.onAuthFailure);
  }
  return core as RequestHandler;
}

export function createExpressAdminAuditMiddleware(options: AdminRouterOptions): RequestHandler {
  const { onAdminAction } = options;
  if (!onAdminAction) {
    return (_req, _res, next) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        return;
      }
      const path = req.path || req.url.split('?')[0] || '';
      onAdminAction({
        method: req.method,
        path,
        key: extractAdminKeyFromPath(path),
        actor: resolveActorFromRequest(req, req.body as { actor?: string } | undefined),
        timestamp: new Date(),
      });
    });
    next();
  };
}

/**
 * Express-shaped response that forwards to Fastify {@link FastifyReply} so
 * `reply.sent` is set and route handlers are not run after a 401.
 */
function createBridgedExpressResponseForFastify(
  reply: FastifyReply,
  onResponseSent: () => void,
): Response {
  const self = {
    get headersSent() {
      return reply.sent;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      reply.header(name, value);
    },
    getHeader(name: string) {
      return reply.getHeader(name);
    },
    status(code: number) {
      void reply.code(code);
      return self as unknown as Response;
    },
    json(body: unknown) {
      void reply.send(body);
      onResponseSent();
      return self as unknown as Response;
    },
    end(chunk?: unknown, _encoding?: unknown, cb?: unknown) {
      if (typeof chunk === 'function') {
        (chunk as () => void)();
        return self as unknown as Response;
      }
      if (typeof cb === 'function') {
        (cb as () => void)();
      }
      if (chunk === undefined || chunk === null) {
        void reply.send();
      } else if (typeof chunk === 'string') {
        try {
          void reply.send(JSON.parse(chunk));
        } catch {
          void reply.send(chunk);
        }
      } else {
        void reply.send(chunk);
      }
      onResponseSent();
      return self as unknown as Response;
    },
  };
  Object.defineProperty(self, 'statusCode', {
    get() {
      return reply.statusCode;
    },
    set(code: number) {
      void reply.code(code);
    },
    configurable: true,
    enumerable: true,
  });
  return self as unknown as Response;
}

async function runExpressMiddlewareOnFastify(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: AdminAuthMiddleware,
): Promise<void> {
  const req = request as unknown as Request;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const onResponseSent = () => {
      settle(() => resolve());
    };

    const res = createBridgedExpressResponseForFastify(reply, onResponseSent);

    const next: NextFunction = (err?: unknown) => {
      if (err) {
        settle(() => reject(err));
        return;
      }
      settle(() => resolve());
    };

    try {
      const out = handler(req, res, next);
      if (out !== undefined && typeof (out as Promise<void>).then === 'function') {
        void (out as Promise<void>).catch((e) => settle(() => reject(e)));
      }
    } catch (e) {
      settle(() => reject(e));
    }
  });
}

export async function authenticateFastifyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AdminRouterOptions,
): Promise<void> {
  let core = resolveAdminAuth(options.auth);
  if (options.onAuthFailure) {
    core = wrapWithCustomAuthFailure(core, options.onAuthFailure);
  }
  await runExpressMiddlewareOnFastify(request, reply, core);
}
