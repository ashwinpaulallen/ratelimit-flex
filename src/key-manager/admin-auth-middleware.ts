import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AdminAuthMode, AdminAuthMiddleware } from './admin-auth.js';

/**
 * Resolve an AdminAuthMode into an Express middleware function.
 * This is the single entry point all adapters use.
 *
 * @param onAuthFailure — When set, invoked for **bearer** / **basic** credential failures instead of
 *   the default 401 + `WWW-Authenticate` response. Ignored for `type: 'middleware'` (handle failures in
 *   your own handler).
 */
export function resolveAdminAuth(
  mode: AdminAuthMode,
  onAuthFailure?: (req: Request, res: Response) => void,
): AdminAuthMiddleware {
  switch (mode.type) {
    case 'bearer':
      return createBearerAuth(mode.token, onAuthFailure);
    case 'basic':
      return createBasicAuth(mode.username, mode.password, onAuthFailure);
    case 'middleware':
      return mode.handler;
    case 'unsafe-no-auth':
      return (_req, _res, next) => next();
  }
}

/**
 * Bearer token auth. Uses timing-safe comparison to prevent token leakage
 * via response-time side channels.
 */
function createBearerAuth(
  expectedToken: string,
  onAuthFailure?: (req: Request, res: Response) => void,
): AdminAuthMiddleware {
  const expected = Buffer.from(expectedToken, 'utf8');

  return (req, res, next) => {
    const header = req.headers?.authorization;
    if (!header || typeof header !== 'string') {
      return sendUnauthorized(req, res, 'Bearer', onAuthFailure);
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const tokenPart = match?.[1];
    if (!tokenPart) {
      return sendUnauthorized(req, res, 'Bearer', onAuthFailure);
    }
    const actual = Buffer.from(tokenPart, 'utf8');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return sendUnauthorized(req, res, 'Bearer', onAuthFailure);
    }
    next();
  };
}

/**
 * HTTP Basic auth. Timing-safe comparison for both username and password.
 */
function createBasicAuth(
  expectedUser: string,
  expectedPass: string,
  onAuthFailure?: (req: Request, res: Response) => void,
): AdminAuthMiddleware {
  const expectedUserBuf = Buffer.from(expectedUser, 'utf8');
  const expectedPassBuf = Buffer.from(expectedPass, 'utf8');

  return (req, res, next) => {
    const header = req.headers?.authorization;
    if (!header || typeof header !== 'string') {
      return sendUnauthorized(req, res, 'Basic', onAuthFailure);
    }
    const match = /^Basic\s+(.+)$/i.exec(header);
    const b64 = match?.[1];
    if (!b64) {
      return sendUnauthorized(req, res, 'Basic', onAuthFailure);
    }
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      return sendUnauthorized(req, res, 'Basic', onAuthFailure);
    }
    const user = Buffer.from(decoded.slice(0, colonIdx), 'utf8');
    const pass = Buffer.from(decoded.slice(colonIdx + 1), 'utf8');

    const userOk =
      user.length === expectedUserBuf.length &&
      timingSafeEqual(user, expectedUserBuf);
    const passOk =
      pass.length === expectedPassBuf.length &&
      timingSafeEqual(pass, expectedPassBuf);

    // IMPORTANT: always evaluate both comparisons before branching, even if
    // the username fails, to prevent timing side channels from distinguishing
    // "bad user" from "bad password".
    if (!userOk || !passOk) {
      return sendUnauthorized(req, res, 'Basic', onAuthFailure);
    }
    next();
  };
}

function sendUnauthorized(
  req: Request,
  res: Response,
  scheme: 'Bearer' | 'Basic',
  onAuthFailure?: (req: Request, res: Response) => void,
): void {
  if (res.headersSent) {
    return;
  }
  if (onAuthFailure) {
    onAuthFailure(req, res);
    return;
  }
  res.setHeader('WWW-Authenticate', scheme);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 401;
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}
