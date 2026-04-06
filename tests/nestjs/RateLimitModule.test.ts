import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import type { RateLimitStore } from '../../src/types/index.js';
import { MetricsManager } from '../../src/metrics/manager.js';
import { RateLimitModule } from '../../src/nestjs/RateLimitModule.js';
import { RATE_LIMIT_METRICS, RATE_LIMIT_OPTIONS, RATE_LIMIT_STORE } from '../../src/nestjs/types.js';

describe('RateLimitModule', () => {
  it('forRoot creates a working module with default MemoryStore', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RateLimitModule.forRoot({ maxRequests: 50, windowMs: 30_000 })],
    }).compile();

    const store = moduleRef.get<RateLimitStore>(RATE_LIMIT_STORE);
    expect(store).toBeInstanceOf(MemoryStore);
  });

  it('forRoot provides MetricsManager via RATE_LIMIT_METRICS', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RateLimitModule.forRoot({
          maxRequests: 10,
          windowMs: 5000,
          metrics: true,
        }),
      ],
    }).compile();

    const mm = moduleRef.get<MetricsManager>(RATE_LIMIT_METRICS);
    expect(mm).toBeInstanceOf(MetricsManager);
    expect(mm.isEnabled()).toBe(true);
  });

  it('forRoot uses the provided custom store instance', async () => {
    const custom = new MemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 10_000,
      maxRequests: 20,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        RateLimitModule.forRoot({
          store: custom,
          maxRequests: 20,
          windowMs: 10_000,
        }),
      ],
    }).compile();

    expect(moduleRef.get(RATE_LIMIT_STORE)).toBe(custom);
  });

  it('forRoot with global: false does not register APP_GUARD', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RateLimitModule.forRoot({ global: false, maxRequests: 5 })],
    }).compile();

    expect(() => moduleRef.get(APP_GUARD, { strict: true })).toThrow();
  });

  it('forRootAsync resolves options from an async factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RateLimitModule.forRootAsync({
          useFactory: async () =>
            Promise.resolve({
              maxRequests: 7,
              windowMs: 15_000,
            }),
        }),
      ],
    }).compile();

    const opts = moduleRef.get(RATE_LIMIT_OPTIONS) as { maxRequests?: number };
    expect(opts.maxRequests).toBe(7);
    expect(moduleRef.get(RATE_LIMIT_STORE)).toBeInstanceOf(MemoryStore);
  });

  it('exposes DI tokens to other providers in the same module', async () => {
    @Injectable()
    class Consumer {
      constructor(@Inject(RATE_LIMIT_STORE) readonly store: RateLimitStore) {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [RateLimitModule.forRoot({})],
      providers: [Consumer],
    }).compile();

    expect(moduleRef.get(Consumer).store).toBeInstanceOf(MemoryStore);
  });

  it('is global: child module can inject tokens without importing RateLimitModule', async () => {
    @Injectable()
    class ChildService {
      constructor(@Inject(RATE_LIMIT_STORE) readonly store: RateLimitStore) {}
    }

    @Module({
      providers: [ChildService],
    })
    class ChildModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [RateLimitModule.forRoot({ maxRequests: 3 }), ChildModule],
    }).compile();

    expect(moduleRef.get(ChildService).store).toBeInstanceOf(MemoryStore);
  });
});
