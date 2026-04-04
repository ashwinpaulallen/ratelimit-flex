import process from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queuedClusterPreset } from '../src/presets/index.js';
import { ClusterStore } from '../src/stores/ClusterStore.js';
import { RateLimitStrategy } from '../src/types/index.js';

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

describe('queuedClusterPreset', () => {
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

  it('returns QueuedRateLimiterOptions with ClusterStore and queue defaults', () => {
    const q = queuedClusterPreset({ maxRequests: 80, maxQueueSize: 50 });

    expect(q.windowMs).toBe(60_000);
    expect(q.maxRequests).toBe(80);
    expect(q.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
    expect(q.store).toBeInstanceOf(ClusterStore);
    expect((q.store as ClusterStore).keyPrefix).toBe('rlf-cluster-queued');
    expect(q.maxQueueSize).toBe(50);
    expect(q.keyPrefix).toBe('rlf-queued');
  });

  it('throws if store is passed explicitly', () => {
    expect(() =>
      queuedClusterPreset({
        store: {} as import('../src/types/index.js').RateLimitStore,
      }),
    ).toThrow('omit `store`');
  });
});
