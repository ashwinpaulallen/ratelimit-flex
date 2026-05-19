import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/composition/index.js';
import { RateLimitGuard } from '../../src/nestjs/RateLimitGuard.js';
import { RATE_LIMIT_OPTIONS, RATE_LIMIT_STORE } from '../../src/nestjs/types.js';
import { RateLimitStrategy } from '../../src/types/index.js';

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

describe('RateLimitGuard + composed store', () => {
  it('attaches req.rateLimit and req.rateLimitComposed.layers (Express parity)', async () => {
    const store = compose.windows(
      { windowMs: 10_000, maxRequests: 50, strategy: RateLimitStrategy.SLIDING_WINDOW },
      { windowMs: 60_000, maxRequests: 200, strategy: RateLimitStrategy.SLIDING_WINDOW },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        Reflector,
        {
          provide: RATE_LIMIT_OPTIONS,
          useValue: {
            strategy: RateLimitStrategy.SLIDING_WINDOW,
            windowMs: 10_000,
            maxRequests: 50,
          },
        },
        { provide: RATE_LIMIT_STORE, useValue: store },
      ],
    }).compile();

    const guard = moduleRef.get(RateLimitGuard);
    const req: Record<string, unknown> = { ip: '10.51.98.33' };
    const res = { setHeader: vi.fn(), header: vi.fn() };

    class C {}
    await expect(guard.canActivate(createHttpContext(req, res, C.prototype, C))).resolves.toBe(true);

    expect(req.rateLimit).toBeDefined();
    expect(req.rateLimitComposed?.layers).toBeDefined();

    await store.shutdown();
  });
});
