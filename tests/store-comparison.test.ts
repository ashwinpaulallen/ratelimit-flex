import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisLikeClient } from '../src/stores/redis-store.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { RedisStore } from '../src/stores/redis-store.js';
import { RateLimitStrategy } from '../src/types/index.js';
import type { CreateStoreOptions } from '../src/utils/store-factory.js';
import { createStore } from '../src/utils/store-factory.js';
import { detectEnvironment } from '../src/utils/environment.js';

// Hoisted so the reference is available inside the vi.mock factory.
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(() => false) }));

vi.mock('node:fs', () => ({ default: fsMock }));
const clusterMock = vi.hoisted(() => ({
  isWorker: false,
  isPrimary: true,
  workers: {} as Record<string, unknown>,
}));

// Default test state: not a worker, primary with no workers.
vi.mock('node:cluster', () => ({
  default: clusterMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRedisClient(): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue(null),
  };
}

const ENV_KEYS = [
  'PM2_HOME',
  'KUBERNETES_SERVICE_HOST',
  'DOCKER',
  'RATELIMIT_FLEX_NO_MEMORY_WARN',
  'RATELIMIT_FLEX_NO_RESILIENCE_WARN',
] as const;

/** Save the current env vars and delete them so each test starts clean. */
function saveAndClearEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const v = saved[key];
    if (v === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// createStore factory
// ---------------------------------------------------------------------------

describe('createStore', () => {
  const stores: Array<{ shutdown(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.shutdown()));
  });

  it('type "memory" returns a MemoryStore instance', () => {
    const store = createStore({
      type: 'memory',
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });
    stores.push(store);
    expect(store).toBeInstanceOf(MemoryStore);
  });

  it('type "memory" with token bucket returns a MemoryStore instance', () => {
    const store = createStore({
      type: 'memory',
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 10,
      interval: 60_000,
      bucketSize: 100,
    });
    stores.push(store);
    expect(store).toBeInstanceOf(MemoryStore);
  });

  it('type "redis" without client or url throws a descriptive error', () => {
    expect(() =>
      createStore({
        type: 'redis',
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        redis: {},
      } as CreateStoreOptions),
    ).toThrow('createStore: redis type requires either redis.client or redis.url');
  });

  it('type "redis" with both client and url throws', () => {
    expect(() =>
      createStore({
        type: 'redis',
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 10,
        redis: {
          client: mockRedisClient(),
          url: 'redis://localhost:6379',
        },
      } as CreateStoreOptions),
    ).toThrow('createStore: pass either redis.client or redis.url, not both');
  });

  it('type "redis" with a mock client returns a RedisStore instance', () => {
    const store = createStore({
      type: 'redis',
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      redis: { client: mockRedisClient() },
    });
    stores.push(store);
    expect(store).toBeInstanceOf(RedisStore);
  });

  it('unknown type throws an error', () => {
    expect(() =>
      createStore({
        type: 'memcached',
        strategy: RateLimitStrategy.SLIDING_WINDOW,
      } as unknown as CreateStoreOptions),
    ).toThrow('createStore: unknown store type "memcached"');
  });
});

// ---------------------------------------------------------------------------
// detectEnvironment
// ---------------------------------------------------------------------------

describe('detectEnvironment', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
    fsMock.existsSync.mockReturnValue(false);
    clusterMock.isWorker = false;
    clusterMock.isPrimary = true;
    clusterMock.workers = {};
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('returns isMultiInstance: false and recommended: "memory" by default', () => {
    const env = detectEnvironment();
    expect(env.isCluster).toBe(false);
    expect(env.isNativeCluster).toBe(false);
    expect(env.isKubernetes).toBe(false);
    expect(env.isDocker).toBe(false);
    expect(env.isMultiInstance).toBe(false);
    expect(env.recommended).toBe('memory');
  });

  it('returns isNativeCluster and recommended cluster for a cluster worker', () => {
    clusterMock.isWorker = true;
    clusterMock.isPrimary = false;
    const env = detectEnvironment();
    expect(env.isNativeCluster).toBe(true);
    expect(env.isMultiInstance).toBe(true);
    expect(env.recommended).toBe('cluster');
  });

  it('returns isNativeCluster when primary has at least one worker', () => {
    clusterMock.isWorker = false;
    clusterMock.isPrimary = true;
    clusterMock.workers = { '1': {} as unknown };
    const env = detectEnvironment();
    expect(env.isNativeCluster).toBe(true);
    expect(env.isMultiInstance).toBe(true);
    expect(env.recommended).toBe('cluster');
  });

  it('returns isKubernetes: true when KUBERNETES_SERVICE_HOST is set', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
    const env = detectEnvironment();
    expect(env.isKubernetes).toBe(true);
    expect(env.isMultiInstance).toBe(true);
    expect(env.recommended).toBe('redis');
  });

  it('returns isCluster: true when PM2_HOME is set', () => {
    process.env.PM2_HOME = '/root/.pm2';
    const env = detectEnvironment();
    expect(env.isCluster).toBe(true);
    expect(env.isMultiInstance).toBe(true);
    expect(env.recommended).toBe('redis');
  });

  it('returns isDocker: true when DOCKER env var is set', () => {
    process.env.DOCKER = '1';
    const env = detectEnvironment();
    expect(env.isDocker).toBe(true);
    expect(env.isMultiInstance).toBe(true);
    expect(env.recommended).toBe('redis');
  });

  it('returns isDocker: true when /.dockerenv file exists', () => {
    fsMock.existsSync.mockReturnValue(true);
    const env = detectEnvironment();
    expect(env.isDocker).toBe(true);
    expect(env.isMultiInstance).toBe(true);
    expect(env.recommended).toBe('redis');
  });
});

// ---------------------------------------------------------------------------
// warnIfMemoryStoreInCluster
// ---------------------------------------------------------------------------

describe('warnIfMemoryStoreInCluster', () => {
  let savedEnv: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
    fsMock.existsSync.mockReturnValue(false);
    clusterMock.isWorker = false;
    clusterMock.isPrimary = true;
    clusterMock.workers = {};
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Each test gets a fresh module so `hasWarned` resets to false.
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    warnSpy.mockRestore();
  });

  it('logs a warning when isMultiInstance is true and store is MemoryStore', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfMemoryStoreInCluster } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const store = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    warnIfMemoryStoreInCluster(store);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('[ratelimit-flex] WARNING: MemoryStore');
    await store.shutdown();
  });

  it('mentions ClusterStore in native cluster environments', async () => {
    clusterMock.isWorker = true;
    clusterMock.isPrimary = false;
    const { warnIfMemoryStoreInCluster } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const store = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    warnIfMemoryStoreInCluster(store);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('ClusterStore');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('RedisStore');
    await store.shutdown();
  });

  it('only fires the warning once even when called multiple times', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfMemoryStoreInCluster } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const store = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    warnIfMemoryStoreInCluster(store);
    warnIfMemoryStoreInCluster(store);
    warnIfMemoryStoreInCluster(store);

    expect(warnSpy).toHaveBeenCalledOnce();
    await store.shutdown();
  });

  it('does not warn when the store is a RedisStore', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfMemoryStoreInCluster } = await import('../src/utils/environment.js');
    const { RedisStore: FreshRedisStore } = await import('../src/stores/redis-store.js');
    const store = new FreshRedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: mockRedisClient(),
    });

    warnIfMemoryStoreInCluster(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
  });

  it('does not warn when isMultiInstance is false, even with a MemoryStore', async () => {
    // No env vars set → isMultiInstance: false
    const { warnIfMemoryStoreInCluster } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const store = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    warnIfMemoryStoreInCluster(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
  });

  it('does not warn when RATELIMIT_FLEX_NO_MEMORY_WARN=1', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    process.env.RATELIMIT_FLEX_NO_MEMORY_WARN = '1';
    const { warnIfMemoryStoreInCluster } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const store = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    warnIfMemoryStoreInCluster(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
  });
});

// ---------------------------------------------------------------------------
// warnIfRedisStoreWithoutInsurance
// ---------------------------------------------------------------------------

describe('warnIfRedisStoreWithoutInsurance', () => {
  let savedEnv: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = saveAndClearEnv();
    fsMock.existsSync.mockReturnValue(false);
    clusterMock.isWorker = false;
    clusterMock.isPrimary = true;
    clusterMock.workers = {};
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    warnSpy.mockRestore();
  });

  it('logs a warning when isMultiInstance is true and RedisStore has no insurance limiter', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfRedisStoreWithoutInsurance } = await import('../src/utils/environment.js');
    const { RedisStore: FreshRedisStore } = await import('../src/stores/redis-store.js');
    const store = new FreshRedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: mockRedisClient(),
    });

    warnIfRedisStoreWithoutInsurance(store);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      'ratelimit-flex: RedisStore detected in a multi-instance environment without an insurance limiter. Consider using resilientRedisPreset() or adding an insuranceLimiter for Redis failover protection.',
    );
    await store.shutdown();
  });

  it('does not warn when resilience.insuranceLimiter is configured', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfRedisStoreWithoutInsurance } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const { RedisStore: FreshRedisStore } = await import('../src/stores/redis-store.js');
    const insurance = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 5,
    });
    const store = new FreshRedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: mockRedisClient(),
      resilience: {
        insuranceLimiter: { store: insurance },
      },
    });

    warnIfRedisStoreWithoutInsurance(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
    await insurance.shutdown();
  });

  it('does not warn when RATELIMIT_FLEX_NO_RESILIENCE_WARN=1', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    process.env.RATELIMIT_FLEX_NO_RESILIENCE_WARN = '1';
    const { warnIfRedisStoreWithoutInsurance } = await import('../src/utils/environment.js');
    const { RedisStore: FreshRedisStore } = await import('../src/stores/redis-store.js');
    const store = new FreshRedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: mockRedisClient(),
    });

    warnIfRedisStoreWithoutInsurance(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
  });

  it('only fires the warning once even when called multiple times', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfRedisStoreWithoutInsurance } = await import('../src/utils/environment.js');
    const { RedisStore: FreshRedisStore } = await import('../src/stores/redis-store.js');
    const store = new FreshRedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: mockRedisClient(),
    });

    warnIfRedisStoreWithoutInsurance(store);
    warnIfRedisStoreWithoutInsurance(store);
    warnIfRedisStoreWithoutInsurance(store);

    expect(warnSpy).toHaveBeenCalledOnce();
    await store.shutdown();
  });

  it('does not warn when isMultiInstance is false', async () => {
    const { warnIfRedisStoreWithoutInsurance } = await import('../src/utils/environment.js');
    const { RedisStore: FreshRedisStore } = await import('../src/stores/redis-store.js');
    const store = new FreshRedisStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
      client: mockRedisClient(),
    });

    warnIfRedisStoreWithoutInsurance(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
  });

  it('does not warn when the store is a MemoryStore', async () => {
    process.env.PM2_HOME = '/root/.pm2';
    const { warnIfRedisStoreWithoutInsurance } = await import('../src/utils/environment.js');
    const { MemoryStore: FreshMemoryStore } = await import('../src/stores/memory-store.js');
    const store = new FreshMemoryStore({
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 10,
    });

    warnIfRedisStoreWithoutInsurance(store);

    expect(warnSpy).not.toHaveBeenCalled();
    await store.shutdown();
  });
});
