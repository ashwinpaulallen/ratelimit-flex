import process from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClusterStore } from '../src/stores/ClusterStore.js';
import { RateLimitStrategy } from '../src/types/index.js';
import type { CreateStoreOptions } from '../src/utils/store-factory.js';
import { createStore } from '../src/utils/store-factory.js';

const clusterMock = vi.hoisted(() => ({
  isWorker: true,
  isPrimary: false,
}));

vi.mock('node:cluster', () => ({
  default: clusterMock,
}));

const mockRandomUUID = vi.hoisted(() => vi.fn(() => '00000000-0000-4000-8000-000000000001'));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => mockRandomUUID() as ReturnType<typeof actual.randomUUID>,
  };
});

describe('createStore type cluster', () => {
  beforeEach(() => {
    const sendMock = vi.fn();
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: sendMock,
    });
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'message') {
        queueMicrotask(() => {
          const initMsg = sendMock.mock.calls.find(
            (c) => c[0] && typeof c[0] === 'object' && (c[0] as { type?: string }).type === 'init',
          )?.[0] as { keyPrefix?: string } | undefined;
          (listener as (msg: unknown) => void)({
            channel: 'rate_limiter_flex',
            type: 'init_ack',
            keyPrefix: initMsg?.keyPrefix ?? 'rlf-cluster',
          });
        });
      }
      return process;
    });
    vi.spyOn(process, 'off').mockImplementation(() => process);
    mockRandomUUID.mockReset();
    mockRandomUUID.mockImplementation(() => '00000000-0000-4000-8000-000000000001');
  });

  it('returns ClusterStore for sliding window', () => {
    const store = createStore({
      type: 'cluster',
      keyPrefix: 'factory-test',
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 5000,
      maxRequests: 20,
      timeoutMs: 2000,
    });
    expect(store).toBeInstanceOf(ClusterStore);
    expect((store as ClusterStore).keyPrefix).toBe('factory-test');
  });

  it('returns ClusterStore for token bucket', () => {
    const store = createStore({
      type: 'cluster',
      keyPrefix: 'tb-factory',
      strategy: RateLimitStrategy.TOKEN_BUCKET,
      tokensPerInterval: 10,
      interval: 60_000,
      bucketSize: 50,
    });
    expect(store).toBeInstanceOf(ClusterStore);
    expect((store as ClusterStore).keyPrefix).toBe('tb-factory');
  });

  it('throws when keyPrefix is empty', () => {
    expect(() =>
      createStore({
        type: 'cluster',
        keyPrefix: '',
        strategy: RateLimitStrategy.SLIDING_WINDOW,
      } as CreateStoreOptions),
    ).toThrow('non-empty keyPrefix');
  });
});
