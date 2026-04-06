import 'reflect-metadata';
import { HttpException, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../src/key-manager/KeyManager.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { RateLimitGuard } from '../../src/nestjs/RateLimitGuard.js';
import { RateLimit, SkipRateLimit } from '../../src/nestjs/decorators.js';
import {
  RATE_LIMIT_METADATA,
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_SKIP_METADATA,
  RATE_LIMIT_STORE,
  type NestRateLimitModuleOptions,
  type RateLimitDecoratorOptions,
} from '../../src/nestjs/types.js';

function createHttpContext(
  req: Record<string, unknown>,
  res: Record<string, unknown>,
  handler: object,
  classRef: object,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
    });
  });

  async function createGuard(moduleOptions: NestRateLimitModuleOptions) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        Reflector,
        { provide: RATE_LIMIT_OPTIONS, useValue: moduleOptions },
        { provide: RATE_LIMIT_STORE, useValue: store },
      ],
    }).compile();
    return moduleRef.get(RateLimitGuard);
  }

  it('allows requests under the limit', async () => {
    const guard = await createGuard({
      maxRequests: 10,
      windowMs: 60_000,
    });
    const req = { ip: '10.0.0.1' };
    const res = { setHeader: vi.fn() };
    class C {}
    const ctx = createHttpContext(req, res, C.prototype, C);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('blocks requests over the limit with 429', async () => {
    const guard = await createGuard({
      maxRequests: 2,
      windowMs: 60_000,
    });
    const req = { ip: '10.0.0.2' };
    const res = { setHeader: vi.fn() };
    class C {}
    const handler = function h() {};
    const ctx = createHttpContext(req, res, handler, C);

    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).rejects.toSatisfy((e: unknown) => {
      return e instanceof HttpException && e.getStatus() === 429;
    });
  });

  it('throws when legacy metadata sets a conflicting strategy (non-production)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const guard = await createGuard({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        maxRequests: 10,
        windowMs: 60_000,
      });
      class Bad {
        x(): void {}
      }
      const d = Object.getOwnPropertyDescriptor(Bad.prototype, 'x');
      if (!d) throw new Error('descriptor');
      SetMetadata(RATE_LIMIT_METADATA, {
        maxRequests: 1,
        strategy: RateLimitStrategy.FIXED_WINDOW,
      })(Bad.prototype, 'x', d);

      const req = { ip: '10.0.0.99' };
      const res = { setHeader: vi.fn() };
      const ctx = createHttpContext(req, res, Bad.prototype.x, Bad);

      await expect(guard.canActivate(ctx)).rejects.toThrow(/strategy/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('does not throw in production when legacy metadata strategy conflicts (strategy ignored)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const guard = await createGuard({
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        maxRequests: 2,
        windowMs: 60_000,
      });
      class Ok {
        x(): void {}
      }
      const d = Object.getOwnPropertyDescriptor(Ok.prototype, 'x');
      if (!d) throw new Error('descriptor');
      SetMetadata(RATE_LIMIT_METADATA, {
        maxRequests: 1,
        strategy: RateLimitStrategy.FIXED_WINDOW,
      })(Ok.prototype, 'x', d);

      const req = { ip: '10.0.0.100' };
      const res = { setHeader: vi.fn() };
      const ctx = createHttpContext(req, res, Ok.prototype.x, Ok);

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('does not reuse a stale per-route engine when merged @RateLimit options change (same handler)', async () => {
    const handler = function dynamicRoute() {};
    let routeMeta: RateLimitDecoratorOptions = { maxRequests: 1, windowMs: 60_000 };
    const reflector = {
      getAllAndOverride: vi.fn((key: unknown) => {
        if (key === RATE_LIMIT_METADATA) {
          return routeMeta;
        }
        if (key === RATE_LIMIT_SKIP_METADATA) {
          return undefined;
        }
        return undefined;
      }),
    } as unknown as Reflector;

    const moduleRef = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: Reflector, useValue: reflector },
        { provide: RATE_LIMIT_OPTIONS, useValue: { maxRequests: 100, windowMs: 60_000 } satisfies NestRateLimitModuleOptions },
        { provide: RATE_LIMIT_STORE, useValue: store },
      ],
    }).compile();
    const guard = moduleRef.get(RateLimitGuard);

    const req = { ip: '10.0.0.dynamic' };
    const res = { setHeader: vi.fn() };
    class C {}
    const ctx = createHttpContext(req, res, handler, C);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);

    routeMeta = { maxRequests: 10, windowMs: 60_000 };
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('applies @RateLimit decorator overrides (stricter cap)', async () => {
    const guard = await createGuard({
      maxRequests: 10,
      windowMs: 60_000,
    });
    class Ctrl {
      tight(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Ctrl.prototype, 'tight');
    if (!descriptor) throw new Error('descriptor');
    RateLimit({ maxRequests: 1, windowMs: 60_000 })(Ctrl.prototype, 'tight', descriptor);

    const req = { ip: '10.0.0.3' };
    const res = { setHeader: vi.fn() };
    const ctx = createHttpContext(req, res, Ctrl.prototype.tight, Ctrl);

    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).rejects.toSatisfy((e: unknown) => {
      return e instanceof HttpException && e.getStatus() === 429;
    });
  });

  it('bypasses when @SkipRateLimit is set', async () => {
    const guard = await createGuard({
      maxRequests: 1,
      windowMs: 60_000,
    });
    class Health {
      ok(): void {}
    }
    const d = Object.getOwnPropertyDescriptor(Health.prototype, 'ok');
    if (!d) throw new Error('descriptor');
    SkipRateLimit()(Health.prototype, 'ok', d);

    const req = { ip: '10.0.0.4' };
    const res = { setHeader: vi.fn() };
    const ctx = createHttpContext(req, res, Health.prototype.ok, Health);

    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('uses custom keyGenerator from route metadata', async () => {
    const guard = await createGuard({
      maxRequests: 1,
      windowMs: 60_000,
    });
    class Api {
      a(): void {}
      b(): void {}
    }
    const da = Object.getOwnPropertyDescriptor(Api.prototype, 'a');
    const db = Object.getOwnPropertyDescriptor(Api.prototype, 'b');
    if (!da || !db) throw new Error('descriptor');
    RateLimit({
      keyGenerator: async () => 'route-a',
    })(Api.prototype, 'a', da);
    RateLimit({
      keyGenerator: async () => 'route-b',
    })(Api.prototype, 'b', db);

    const req = { ip: '10.0.0.5' };
    const res = { setHeader: vi.fn() };

    await guard.canActivate(createHttpContext(req, res, Api.prototype.a, Api));
    await expect(guard.canActivate(createHttpContext(req, res, Api.prototype.a, Api))).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(guard.canActivate(createHttpContext(req, res, Api.prototype.b, Api))).resolves.toBe(true);
  });

  it('uses custom errorFactory for rate-limit errors', async () => {
    const guard = await createGuard({
      maxRequests: 1,
      windowMs: 60_000,
      errorFactory: (_ctx, result) =>
        new HttpException({ tea: 'pot', remaining: result.remaining }, 418),
    });
    const req = { ip: '10.0.0.6' };
    const res = { setHeader: vi.fn() };
    class C {}
    const ctx = createHttpContext(req, res, C.prototype, C);

    await guard.canActivate(ctx);
    try {
      await guard.canActivate(ctx);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const ex = e as HttpException;
      expect(ex.getStatus()).toBe(418);
      expect(ex.getResponse()).toMatchObject({ tea: 'pot' });
    }
  });

  it('allows allowlisted keys without consuming quota', async () => {
    const guard = await createGuard({
      maxRequests: 1,
      windowMs: 60_000,
      allowlist: ['vip'],
    });
    const req = { ip: 'vip' };
    const res = { setHeader: vi.fn() };
    class C {}
    const ctx = createHttpContext(req, res, C.prototype, C);

    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('blocks blocklisted keys with 403', async () => {
    const guard = await createGuard({
      maxRequests: 100,
      windowMs: 60_000,
      blocklist: ['blocked'],
      blocklistStatusCode: 403,
      blocklistMessage: 'Forbidden',
    });
    const req = { ip: 'blocked' };
    const res = { setHeader: vi.fn() };
    class C {}
    const ctx = createHttpContext(req, res, C.prototype, C);

    await expect(guard.canActivate(ctx)).rejects.toSatisfy((e: unknown) => {
      return e instanceof HttpException && e.getStatus() === 403;
    });
  });

  it('short-circuits on KeyManager block before store increment', async () => {
    const km = new KeyManager({
      store,
      maxRequests: 100,
      windowMs: 60_000,
    });
    await km.block('nope', 60_000);

    const guard = await createGuard({
      maxRequests: 100,
      windowMs: 60_000,
      keyManager: km,
    });

    const req = { ip: 'nope' };
    const res = { setHeader: vi.fn() };
    class C {}
    const ctx = createHttpContext(req, res, C.prototype, C);

    await expect(guard.canActivate(ctx)).rejects.toSatisfy((e: unknown) => {
      return e instanceof HttpException && e.getStatus() === 429;
    });
  });

  it('sets rate limit headers on the response when enabled', async () => {
    const guard = await createGuard({
      maxRequests: 5,
      windowMs: 60_000,
      standardHeaders: true,
    });
    const req = { ip: '10.0.0.7' };
    const setHeader = vi.fn();
    const res = { setHeader };
    class C {}
    const ctx = createHttpContext(req, res, C.prototype, C);

    await guard.canActivate(ctx);
    expect(setHeader).toHaveBeenCalled();
    const names = setHeader.mock.calls.map((c) => c[0]);
    expect(names.some((n) => String(n).toLowerCase().includes('ratelimit') || n === 'X-RateLimit-Limit')).toBe(
      true,
    );
  });

  it('applies weighted cost from route decorator', async () => {
    const guard = await createGuard({
      maxRequests: 10,
      windowMs: 60_000,
    });
    class Heavy {
      run(): void {}
    }
    const d = Object.getOwnPropertyDescriptor(Heavy.prototype, 'run');
    if (!d) throw new Error('descriptor');
    RateLimit({ cost: 5 })(Heavy.prototype, 'run', d);

    const req = { ip: '10.0.0.8' };
    const res = { setHeader: vi.fn() };
    const ctx = createHttpContext(req, res, Heavy.prototype.run, Heavy);

    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);
  });

  describe('getRequestResponse and non-HTTP transports', () => {
    function getRequestResponsePair(
      guard: RateLimitGuard,
      context: ExecutionContext,
    ): { req: unknown; res: unknown } {
      return (
        guard as unknown as {
          getRequestResponse: (c: ExecutionContext) => { req: unknown; res: unknown };
        }
      ).getRequestResponse(context);
    }

    it('http context extracts req/res from switchToHttp', async () => {
      const guard = await createGuard({ maxRequests: 10, windowMs: 60_000 });
      const req = { ip: '1.1.1.1' };
      const res = { setHeader: vi.fn() };
      class C {}
      const ctx = createHttpContext(req, res, C.prototype, C);
      const out = getRequestResponsePair(guard, ctx);
      expect(out.req).toBe(req);
      expect(out.res).toBe(res);
    });

    it('graphql context extracts req/res from GqlExecutionContext', async () => {
      const { GqlExecutionContext } = await import('@nestjs/graphql');
      const spy = vi.spyOn(GqlExecutionContext, 'create').mockReturnValue({
        getContext: () => ({
          req: { ip: '8.8.8.8' },
          res: { setHeader: vi.fn() },
        }),
      } as unknown as ReturnType<typeof GqlExecutionContext.create>);
      const guard = await createGuard({ maxRequests: 10, windowMs: 60_000 });
      const ctx = {
        getHandler: () => ({}),
        getClass: () => class G {},
        getType: () => 'graphql',
        switchToHttp: () => ({
          getRequest: () => ({ fallback: true }),
          getResponse: () => ({ fallback: true }),
        }),
      } as unknown as ExecutionContext;
      const out = getRequestResponsePair(guard, ctx);
      expect((out.req as { ip?: string }).ip).toBe('8.8.8.8');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('websocket context extracts IP from client socket', async () => {
      const guard = await createGuard({ maxRequests: 10, windowMs: 60_000 });
      const ctx = {
        getHandler: () => ({}),
        getClass: () => class W {},
        getType: () => 'ws',
        switchToHttp: () => ({
          getRequest: () => ({}),
          getResponse: () => ({}),
        }),
        switchToWs: () => ({
          getClient: () => ({
            _socket: { remoteAddress: '10.0.0.99' },
          }),
        }),
      } as unknown as ExecutionContext;
      const out = getRequestResponsePair(guard, ctx);
      expect((out.req as { ip?: string }).ip).toBe('10.0.0.99');
      expect(out.res).toEqual({});
    });

    it('does not set HTTP headers when response object has no setHeader or header (ws-style)', async () => {
      const guard = await createGuard({
        maxRequests: 100,
        windowMs: 60_000,
        standardHeaders: true,
      });
      class H {}
      const ctx = {
        getHandler: () => H.prototype,
        getClass: () => H,
        getType: () => 'ws',
        switchToHttp: () => ({
          getRequest: () => ({}),
          getResponse: () => ({}),
        }),
        switchToWs: () => ({
          getClient: () => ({
            _socket: { remoteAddress: '10.0.0.2' },
          }),
        }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('rpc context uses Rpc context payload as req', async () => {
      const guard = await createGuard({ maxRequests: 10, windowMs: 60_000 });
      const rpcCtx = { data: { id: 'rpc-1' } };
      const ctx = {
        getHandler: () => ({}),
        getClass: () => class R {},
        getType: () => 'rpc',
        switchToHttp: () => ({
          getRequest: () => ({}),
          getResponse: () => ({}),
        }),
        switchToRpc: () => ({
          getContext: () => rpcCtx,
        }),
      } as unknown as ExecutionContext;
      const out = getRequestResponsePair(guard, ctx);
      expect(out.req).toBe(rpcCtx);
      expect(out.res).toEqual({});
    });
  });
});
