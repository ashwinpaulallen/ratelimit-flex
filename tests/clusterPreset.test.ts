import process from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { clusterPreset } from '../src/presets/index.js';
import { ClusterStore } from '../src/stores/ClusterStore.js';
import { RateLimitStrategy } from '../src/types/index.js';

describe('clusterPreset', () => {
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
            (c) => c[0] && typeof c[0] === 'object' && (c[0] as { type?: string }).type === 'init'
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

  it('returns sliding-window options with ClusterStore and defaults', () => {
    const partial = clusterPreset({ maxRequests: 100 });

    expect(partial.strategy).toBe(RateLimitStrategy.SLIDING_WINDOW);
    expect(partial.windowMs).toBe(60_000);
    expect(partial.maxRequests).toBe(100);
    expect(partial.standardHeaders).toBe('draft-6');
    expect(partial.store).toBeInstanceOf(ClusterStore);
    expect((partial.store as ClusterStore).keyPrefix).toBe('rlf-cluster');
  });

  it('passes keyPrefix and timeoutMs to ClusterStore', () => {
    const partial = clusterPreset({
      keyPrefix: 'my-app',
      timeoutMs: 3000,
      maxRequests: 50,
    });

    expect((partial.store as ClusterStore).keyPrefix).toBe('my-app');
  });
});
