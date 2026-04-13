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
   * Optional handler for **built-in** bearer/basic auth failures (missing or invalid
   * credentials). Passed to the bearer/basic middleware instead of the default 401 +
   * `WWW-Authenticate` response. Not used for `auth.type === 'middleware'` — implement
   * failure responses inside your custom handler.
   *
   * **Express (`createAdminRouter`):** `req` and `res` are real Express objects.
   *
   * **Fastify (`createFastifyAdminPlugin`):** `res` is a bridge object that forwards to
   * `FastifyReply` — `res.status(...)`, `res.json(...)`, headers, etc. work as the built-in auth
   * expects. **`req` is typed as Express `Request` only so the same middleware can run in both
   * environments; at runtime it is the underlying {@link FastifyRequest} cast.** Do not call
   * Express-only helpers such as `req.path`, `req.query`, or `req.get()` — they are not present and
   * may throw or return `undefined`. Prefer handling failures via `res` only, or read portable
   * fields (e.g. `url`, `headers`) if you need request context.
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

/** Shared with {@link createAdminRouter} and the Fastify admin plugin — one message, `stderr`. */
const UNSAFE_NO_AUTH_STDERR_MESSAGE =
  '[ratelimit-flex] WARNING: KeyManager admin router mounted with ' +
    '`unsafe-no-auth`. This exposes block/unblock/reward endpoints ' +
    'without authentication. Use only for development and tests. ' +
    'For production, use { type: "bearer" | "basic" | "middleware" }.\n';

export function warnUnsafeNoAuthIfNeeded(auth: AdminAuthMode): void {
  if (auth.type === 'unsafe-no-auth') {
    process.stderr.write(UNSAFE_NO_AUTH_STDERR_MESSAGE);
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

function buildResolvedAdminAuthMiddleware(options: AdminRouterOptions): AdminAuthMiddleware {
  return resolveAdminAuth(options.auth, options.onAuthFailure);
}

export function createExpressAdminAuthMiddleware(options: AdminRouterOptions): RequestHandler {
  return buildResolvedAdminAuthMiddleware(options) as RequestHandler;
}

/**
 * Resolves {@link resolveAdminAuth} once (same as {@link createExpressAdminAuthMiddleware}) and
 * returns a Fastify `(request, reply)` function. Use this from the Fastify plugin registration path —
 * do not re-resolve per request.
 */
export function createFastifyAdminAuthHandler(
  options: AdminRouterOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const core = buildResolvedAdminAuthMiddleware(options);
  return (request, reply) => runExpressMiddlewareOnFastify(request, reply, core);
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

