import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from 'node:cluster';

import { ClusterStorePrimary } from '../../src/cluster/ClusterStorePrimary.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const mockCluster = vi.hoisted(() => ({
  isPrimary: true,
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('node:cluster', () => ({
  default: mockCluster,
}));

function mockWorker(): Worker & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() } as Worker & { send: ReturnType<typeof vi.fn> };
}

describe('ClusterStorePrimary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCluster.isPrimary = true;
    ClusterStorePrimary.destroy();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    ClusterStorePrimary.destroy();
    vi.useRealTimers();
  });

  it('singleton: init() twice returns the same instance', () => {
    const a = ClusterStorePrimary.init();
    const b = ClusterStorePrimary.init();
    expect(a).toBe(b);
    expect(mockCluster.on).toHaveBeenCalledTimes(1);
    expect(mockCluster.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('throws when not primary', () => {
    ClusterStorePrimary.destroy();
    mockCluster.isPrimary = false;
    expect(() => ClusterStorePrimary.init()).toThrow(
      'ClusterStorePrimary.init() must be called in the primary process'
    );
  });

  it('init creates a MemoryStore with correct options (sliding window cap)', async () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'init',
      keyPrefix: 'p1',
      storeOptions: {
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 2,
      },
    });

    await vi.waitFor(() => {
      expect(worker.send).toHaveBeenCalledWith({
        channel: 'rate_limiter_flex',
        type: 'init_ack',
        keyPrefix: 'p1',
      });
    });

    worker.send.mockClear();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: 'r1',
      keyPrefix: 'p1',
      key: 'k',
    });
    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: 'r2',
      keyPrefix: 'p1',
      key: 'k',
    });
    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: 'r3',
      keyPrefix: 'p1',
      key: 'k',
    });

    await vi.waitFor(() => expect(worker.send).toHaveBeenCalledTimes(3));

    const results = worker.send.mock.calls.map((c) => c[0]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      type: 'result',
      id: 'r1',
      success: true,
      data: expect.objectContaining({
        totalHits: 1,
        isBlocked: false,
      }),
    });
    expect(results[1]).toMatchObject({
      type: 'result',
      id: 'r2',
      success: true,
      data: expect.objectContaining({
        totalHits: 2,
        isBlocked: false,
      }),
    });
    expect(results[2]).toMatchObject({
      type: 'result',
      id: 'r3',
      success: true,
      data: expect.objectContaining({
        isBlocked: true,
      }),
    });
  });

  it('increment with unknown keyPrefix returns success: false', async () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: 'x1',
      keyPrefix: 'missing',
      key: 'k',
    });

    await vi.waitFor(() => {
      expect(worker.send).toHaveBeenCalledWith({
        channel: 'rate_limiter_flex',
        type: 'result',
        id: 'x1',
        keyPrefix: 'missing',
        success: false,
        error: 'Store not initialized for keyPrefix: missing',
      });
    });
  });

  it('decrement sends ack', async () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'init',
      keyPrefix: 'p1',
      storeOptions: {
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
      },
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());
    worker.send.mockClear();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: 'i1',
      keyPrefix: 'p1',
      key: 'k',
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());
    worker.send.mockClear();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'decrement',
      id: 'd1',
      keyPrefix: 'p1',
      key: 'k',
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());

    expect(worker.send).toHaveBeenCalledWith({
      channel: 'rate_limiter_flex',
      type: 'ack',
      id: 'd1',
      keyPrefix: 'p1',
    });
  });

  it('reset sends ack', async () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'init',
      keyPrefix: 'p1',
      storeOptions: {
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 2,
      },
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());
    worker.send.mockClear();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'reset',
      id: 'rs1',
      keyPrefix: 'p1',
      key: 'k',
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());

    expect(worker.send).toHaveBeenCalledWith({
      channel: 'rate_limiter_flex',
      type: 'ack',
      id: 'rs1',
      keyPrefix: 'p1',
    });
  });

  it('shutdown removes the store', async () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'init',
      keyPrefix: 'p1',
      storeOptions: {
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 1000,
        maxRequests: 10,
      },
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());
    worker.send.mockClear();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'shutdown',
      id: 's1',
      keyPrefix: 'p1',
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());

    expect(worker.send).toHaveBeenCalledWith({
      channel: 'rate_limiter_flex',
      type: 'ack',
      id: 's1',
      keyPrefix: 'p1',
    });

    worker.send.mockClear();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: 'after',
      keyPrefix: 'p1',
      key: 'k',
    });
    await vi.waitFor(() => expect(worker.send).toHaveBeenCalled());

    expect(worker.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        success: false,
        error: 'Store not initialized for keyPrefix: p1',
      })
    );
  });

  it('only processes messages on the rate_limiter_flex channel', () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'other_channel',
      type: 'increment',
      id: 'n1',
      keyPrefix: 'p',
      key: 'k',
    } as unknown as Parameters<ClusterStorePrimary['handleMessage']>[1]);

    expect(worker.send).not.toHaveBeenCalled();
  });

  it('ignores primary → worker message shapes on the same channel', () => {
    const primary = ClusterStorePrimary.init();
    const worker = mockWorker();

    primary.handleMessage(worker, {
      channel: 'rate_limiter_flex',
      type: 'result',
      id: 'bogus',
      keyPrefix: 'p',
      success: true,
      data: {
        totalHits: 0,
        remaining: 0,
        resetTime: new Date().toISOString(),
        isBlocked: false,
      },
    });

    expect(worker.send).not.toHaveBeenCalled();
  });

  it('destroy() removes the cluster listener and clears singleton state', () => {
    const a = ClusterStorePrimary.init();
    expect(mockCluster.on).toHaveBeenCalled();

    ClusterStorePrimary.destroy();

    expect(mockCluster.off).toHaveBeenCalledWith('message', expect.any(Function));

    const b = ClusterStorePrimary.init();
    expect(b).not.toBe(a);
    expect(mockCluster.on).toHaveBeenCalledTimes(2);
  });
});
