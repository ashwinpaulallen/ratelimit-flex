import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRandomUUID = vi.hoisted(() => vi.fn<[], `${string}-${string}-${string}-${string}-${string}`>());

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => mockRandomUUID() as ReturnType<typeof actual.randomUUID>,
  };
});

const mockCluster = vi.hoisted(() => ({
  isWorker: true,
}));

vi.mock('node:cluster', () => ({
  default: mockCluster,
}));

import { createRateLimiterQueue } from '../../src/queue/createRateLimiterQueue.js';
import { ClusterStore } from '../../src/stores/ClusterStore.js';
import { RateLimitStrategy } from '../../src/types/index.js';

describe('createRateLimiterQueue + ClusterStore (mock IPC)', () => {
  let msgHandler: (msg: unknown) => void;
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCluster.isWorker = true;
    msgHandler = () => {};
    sendMock = vi.fn();

    mockRandomUUID.mockReset();
    mockRandomUUID
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001' as never)
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002' as never);

    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: sendMock,
    });

    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'message') {
        msgHandler = listener as (msg: unknown) => void;
      }
      return process;
    });

    vi.spyOn(process, 'off').mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function ackInit(keyPrefix: string): void {
    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'init_ack',
      keyPrefix,
    });
  }

  it('removeTokens runs against ClusterStore increment/decrement over IPC', async () => {
    const store = new ClusterStore({
      keyPrefix: 'q-factory',
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 2,
      timeoutMs: 200,
    });

    ackInit('q-factory');

    const q = createRateLimiterQueue({
      maxRequests: 2,
      windowMs: 60_000,
      store,
    });

    const p = q.removeTokens('job-key');
    await flushMicrotasks();

    const sent = sendMock.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'increment',
    )?.[0] as { id: string; key: string };
    expect(sent?.key).toBe('job-key');
    expect(sent?.id).toBe('00000000-0000-4000-8000-000000000001');

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: sent.id,
      keyPrefix: 'q-factory',
      success: true,
      data: {
        totalHits: 1,
        remaining: 1,
        resetTime: '2026-06-01T12:01:00.000Z',
        isBlocked: false,
      },
    });

    const r = await p;
    expect(r.remaining).toBe(1);

    q.shutdown();
    await flushMicrotasks();
    const shutdownMsg = [...sendMock.mock.calls]
      .map((c) => c[0] as { type?: string; id?: string })
      .find((m) => m.type === 'shutdown');
    expect(shutdownMsg?.id).toBe('00000000-0000-4000-8000-000000000002');

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: shutdownMsg!.id!,
      keyPrefix: 'q-factory',
      success: false,
      error: 'shutdown',
    });
    await flushMicrotasks();
  });
});
