import process from 'node:process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRandomUUID = vi.hoisted(() => vi.fn<[], `${string}-${string}-${string}-${string}-${string}`>());

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => mockRandomUUID() as ReturnType<typeof actual.randomUUID>,
  };
});

import { CLUSTER_IPC_PROTOCOL_VERSION } from '../../src/cluster/protocol.js';
import { ClusterStore } from '../../src/stores/ClusterStore.js';
import { RateLimitStrategy } from '../../src/types/index.js';

const mockCluster = vi.hoisted(() => ({
  isWorker: true,
}));

vi.mock('node:cluster', () => ({
  default: mockCluster,
}));

describe('ClusterStore', () => {
  let msgHandler: (msg: unknown) => void;
  let sendMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockCluster.isWorker = true;
    msgHandler = () => {};
    sendMock = vi.fn();

    mockRandomUUID.mockReset();
    mockRandomUUID.mockImplementation(() => '00000000-0000-4000-8000-000000000001');

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

  /** Let async increment/decrement bodies run past `await this._ready` before asserting on `process.send`. */
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function createStore(keyPrefix = 'kp1', timeoutMs = 100): ClusterStore {
    return new ClusterStore({
      keyPrefix,
      strategy: RateLimitStrategy.SLIDING_WINDOW,
      windowMs: 60_000,
      maxRequests: 100,
      timeoutMs,
    });
  }

  function ackInit(keyPrefix = 'kp1'): void {
    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'init_ack',
      keyPrefix,
    });
  }

  it('constructor sends init message and waits for init_ack', async () => {
    mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-0000000000aa' as never);

    const store = createStore('my-prefix');

    expect(sendMock).toHaveBeenCalledWith({
      channel: 'rate_limiter_flex',
      type: 'init',
      keyPrefix: 'my-prefix',
      storeOptions: {
        strategy: RateLimitStrategy.SLIDING_WINDOW,
        windowMs: 60_000,
        maxRequests: 100,
      },
      protocolVersion: CLUSTER_IPC_PROTOCOL_VERSION,
    });

    ackInit('my-prefix');

    const inc = store.increment('k');
    await flushMicrotasks();

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: '00000000-0000-4000-8000-0000000000aa',
      keyPrefix: 'my-prefix',
      success: true,
      data: {
        totalHits: 1,
        remaining: 99,
        resetTime: '2026-06-01T12:00:00.000Z',
        isBlocked: false,
      },
    });

    await inc;
  });

  it('init_nack rejects ready and causes increment to fail', async () => {
    const store = createStore('nack-kp');
    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'init_nack',
      keyPrefix: 'nack-kp',
      error: 'upgrade primary first',
      supportedProtocolVersion: 1,
    });
    await expect(store.increment('k')).rejects.toThrow('upgrade primary first');
  });

  it('constructor throws a PM2-specific error when PM2_HOME is set and not a cluster worker', () => {
    mockCluster.isWorker = false;
    vi.stubEnv('PM2_HOME', '/tmp/.pm2');
    expect(
      () =>
        new ClusterStore({
          keyPrefix: 'p',
          strategy: RateLimitStrategy.SLIDING_WINDOW,
        }),
    ).toThrow(/ClusterStore is incompatible with PM2/);
  });

  it('constructor throws a PM2-specific error when pm_id is set and not a cluster worker', () => {
    mockCluster.isWorker = false;
    vi.stubEnv('pm_id', '0');
    expect(
      () =>
        new ClusterStore({
          keyPrefix: 'p',
          strategy: RateLimitStrategy.SLIDING_WINDOW,
        }),
    ).toThrow(/ClusterStore is incompatible with PM2/);
  });

  it('constructor throws if not in cluster worker', () => {
    mockCluster.isWorker = false;
    expect(
      () =>
        new ClusterStore({
          keyPrefix: 'p',
          strategy: RateLimitStrategy.SLIDING_WINDOW,
        }),
    ).toThrow('cluster worker');
  });

  it('constructor throws if keyPrefix is missing', () => {
    expect(
      () =>
        new ClusterStore({
          keyPrefix: '',
          strategy: RateLimitStrategy.SLIDING_WINDOW,
        })
    ).toThrow('keyPrefix');
  });

  it('constructor throws if process.send is undefined', () => {
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(
      () =>
        new ClusterStore({
          keyPrefix: 'p',
          strategy: RateLimitStrategy.SLIDING_WINDOW,
        })
    ).toThrow('process.send');
  });

  it('increment sends correct IPC message and resolves with parsed result', async () => {
    mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-00000000ab01' as never);

    const store = createStore();
    ackInit();

    const p = store.increment('client-key', { maxRequests: 50, cost: 2 });
    await flushMicrotasks();

    expect(sendMock).toHaveBeenNthCalledWith(2, {
      channel: 'rate_limiter_flex',
      type: 'increment',
      id: '00000000-0000-4000-8000-00000000ab01',
      keyPrefix: 'kp1',
      key: 'client-key',
      options: { maxRequests: 50, cost: 2 },
    });

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: '00000000-0000-4000-8000-00000000ab01',
      keyPrefix: 'kp1',
      success: true,
      data: {
        totalHits: 3,
        remaining: 47,
        resetTime: '2026-03-15T08:30:00.000Z',
        isBlocked: false,
      },
    });

    const result = await p;

    expect(result).toEqual({
      totalHits: 3,
      remaining: 47,
      resetTime: new Date('2026-03-15T08:30:00.000Z'),
      isBlocked: false,
    });
  });

  it('increment rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-00000000dead' as never);

      const store = createStore('kp1', 20);
      ackInit();

      const p = store.increment('k');
      const assertion = expect(p).rejects.toThrow(
        'ClusterStore: primary did not respond within 20ms'
      );
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('increment rejects when primary returns success: false', async () => {
    mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-00000000fail' as never);

    const store = createStore();
    ackInit();

    const p = store.increment('k');
    await flushMicrotasks();

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: '00000000-0000-4000-8000-00000000fail',
      keyPrefix: 'kp1',
      success: false,
      error: 'Store not initialized for keyPrefix: kp1',
    });

    await expect(p).rejects.toThrow('Store not initialized for keyPrefix: kp1');
  });

  it('decrement sends correct message and resolves on ack', async () => {
    mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-00000000dec0' as never);

    const store = createStore();
    ackInit();

    const p = store.decrement('k', { cost: 2 });
    await flushMicrotasks();

    expect(sendMock).toHaveBeenNthCalledWith(2, {
      channel: 'rate_limiter_flex',
      type: 'decrement',
      id: '00000000-0000-4000-8000-00000000dec0',
      keyPrefix: 'kp1',
      key: 'k',
      options: { cost: 2 },
    });

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'ack',
      id: '00000000-0000-4000-8000-00000000dec0',
      keyPrefix: 'kp1',
    });

    await p;
  });

  it('reset sends correct message and resolves on ack', async () => {
    mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-00000000e5e5' as never);

    const store = createStore();
    ackInit();

    const p = store.reset('k');
    await flushMicrotasks();

    expect(sendMock).toHaveBeenNthCalledWith(2, {
      channel: 'rate_limiter_flex',
      type: 'reset',
      id: '00000000-0000-4000-8000-00000000e5e5',
      keyPrefix: 'kp1',
      key: 'k',
    });

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'ack',
      id: '00000000-0000-4000-8000-00000000e5e5',
      keyPrefix: 'kp1',
    });

    await p;
  });

  it('shutdown cleans up listener', async () => {
    mockRandomUUID.mockReturnValueOnce('00000000-0000-4000-8000-000000005d00' as never);

    const store = createStore();
    ackInit();

    const offSpy = vi.spyOn(process, 'off');

    const p = store.shutdown();
    await flushMicrotasks();

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'ack',
      id: '00000000-0000-4000-8000-000000005d00',
      keyPrefix: 'kp1',
    });

    await p;

    expect(offSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('multiple concurrent increments for different keys resolve independently', async () => {
    mockRandomUUID
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000aaa1' as never)
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000bbb2' as never);

    const store = createStore();
    ackInit();

    const p1 = store.increment('key-a');
    const p2 = store.increment('key-b');
    await flushMicrotasks();

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: '00000000-0000-4000-8000-00000000bbb2',
      keyPrefix: 'kp1',
      success: true,
      data: {
        totalHits: 1,
        remaining: 9,
        resetTime: '2026-01-02T00:00:00.000Z',
        isBlocked: false,
      },
    });

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: '00000000-0000-4000-8000-00000000aaa1',
      keyPrefix: 'kp1',
      success: true,
      data: {
        totalHits: 2,
        remaining: 8,
        resetTime: '2026-01-03T00:00:00.000Z',
        isBlocked: false,
      },
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.totalHits).toBe(2);
    expect(r2.totalHits).toBe(1);
  });

  it('warns when pending map already has an entry for the same id', async () => {
    const dupId = '00000000-0000-4000-8000-00000000d00d';
    mockRandomUUID.mockReturnValue(dupId as never);

    const store = createStore();
    ackInit();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p1 = store.increment('k1');
    await flushMicrotasks();
    const p2 = store.increment('k2');
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`duplicate id ${dupId}`)
    );

    await expect(p1).rejects.toThrow('superseded');

    msgHandler({
      channel: 'rate_limiter_flex',
      type: 'result',
      id: dupId,
      keyPrefix: 'kp1',
      success: true,
      data: {
        totalHits: 1,
        remaining: 0,
        resetTime: '2026-01-01T00:00:00.000Z',
        isBlocked: false,
      },
    });

    await p2;

    warnSpy.mockRestore();
  });
});
