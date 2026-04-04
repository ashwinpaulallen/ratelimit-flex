import cluster, { type Worker } from 'node:cluster';

import { MemoryStore } from '../stores/memory-store.js';
import { RateLimitStrategy } from '../types/index.js';
import type {
  ClusterPrimaryMessage,
  ClusterStoreInitOptions,
  ClusterWorkerMessage,
} from './protocol.js';
import { isRateLimitFlexMessage } from './protocol.js';

function isClusterWorkerInboundMessage(
  msg: ClusterWorkerMessage | ClusterPrimaryMessage
): msg is ClusterWorkerMessage {
  switch (msg.type) {
    case 'init':
    case 'increment':
    case 'decrement':
    case 'reset':
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

function parseStrategy(value: string): RateLimitStrategy {
  if (
    value === RateLimitStrategy.SLIDING_WINDOW ||
    value === RateLimitStrategy.FIXED_WINDOW ||
    value === RateLimitStrategy.TOKEN_BUCKET
  ) {
    return value;
  }
  throw new Error(`Unknown strategy: ${value}`);
}

function createMemoryStoreFromClusterOptions(opts: ClusterStoreInitOptions): MemoryStore {
  const strategy = parseStrategy(opts.strategy);
  if (strategy === RateLimitStrategy.TOKEN_BUCKET) {
    return new MemoryStore({
      strategy,
      tokensPerInterval: opts.tokensPerInterval ?? 1,
      interval: opts.interval ?? 1000,
      bucketSize: opts.bucketSize ?? opts.tokensPerInterval ?? 1,
    });
  }
  return new MemoryStore({
    strategy,
    windowMs: opts.windowMs ?? 60_000,
    maxRequests: opts.maxRequests ?? 100,
  });
}

const CHANNEL = 'rate_limiter_flex' as const;

function storeMissingError(keyPrefix: string): string {
  return `Store not initialized for keyPrefix: ${keyPrefix}`;
}

export class ClusterStorePrimary {
  private static instance: ClusterStorePrimary | null = null;

  private readonly stores = new Map<string, MemoryStore>();

  private listening = false;

  /**
   * Serializes primary-side handling so concurrent worker IPC cannot race {@link MemoryStore}.
   * Queue grows unbounded if workers send faster than primary processes, but local IPC + in-memory
   * stores are fast enough that backpressure is unlikely in practice.
   */
  private dispatchSerial: Promise<void> = Promise.resolve();

  private readonly messageListener = (worker: Worker, msg: unknown): void => {
    this.handleMessage(worker, msg);
  };

  private constructor() {}

  /** Singleton — call once in the primary process */
  static init(): ClusterStorePrimary {
    if (ClusterStorePrimary.instance) return ClusterStorePrimary.instance;
    if (!cluster.isPrimary) {
      throw new Error('ClusterStorePrimary.init() must be called in the primary process');
    }
    const inst = new ClusterStorePrimary();
    inst.startListening();
    ClusterStorePrimary.instance = inst;
    return inst;
  }

  private startListening(): void {
    if (this.listening) return;
    cluster.on('message', this.messageListener);
    this.listening = true;
  }

  /**
   * Entry point for IPC messages. Public so tests can invoke without a real cluster worker.
   */
  handleMessage(worker: Worker, msg: unknown): void {
    if (!isRateLimitFlexMessage(msg)) return;
    if (!isClusterWorkerInboundMessage(msg)) return;
    const inbound = msg;
    this.dispatchSerial = this.dispatchSerial
      .then(() => this.dispatchWorkerMessage(worker, inbound))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Last-resort: only relevant when a branch forgets to reply
        if (
          inbound.type === 'increment' ||
          inbound.type === 'decrement' ||
          inbound.type === 'reset'
        ) {
          worker.send({
            channel: CHANNEL,
            type: 'result',
            id: inbound.id,
            keyPrefix: inbound.keyPrefix,
            success: false,
            error: message,
          } satisfies ClusterPrimaryMessage);
        }
      });
  }

  private async dispatchWorkerMessage(worker: Worker, msg: ClusterWorkerMessage): Promise<void> {
    switch (msg.type) {
      case 'init':
        await this.handleInit(worker, msg);
        break;
      case 'increment':
        await this.handleIncrement(worker, msg);
        break;
      case 'decrement':
        await this.handleDecrement(worker, msg);
        break;
      case 'reset':
        await this.handleReset(worker, msg);
        break;
      case 'shutdown':
        await this.handleShutdown(worker, msg);
        break;
    }
  }

  private async handleInit(worker: Worker, msg: Extract<ClusterWorkerMessage, { type: 'init' }>): Promise<void> {
    if (this.stores.has(msg.keyPrefix)) {
      // Additional workers for the same limiter share the existing store — do not replace (would reset counters).
      worker.send({
        channel: CHANNEL,
        type: 'init_ack',
        keyPrefix: msg.keyPrefix,
      } satisfies ClusterPrimaryMessage);
      return;
    }
    const store = createMemoryStoreFromClusterOptions(msg.storeOptions);
    this.stores.set(msg.keyPrefix, store);
    worker.send({
      channel: CHANNEL,
      type: 'init_ack',
      keyPrefix: msg.keyPrefix,
    } satisfies ClusterPrimaryMessage);
  }

  private async handleIncrement(
    worker: Worker,
    msg: Extract<ClusterWorkerMessage, { type: 'increment' }>
  ): Promise<void> {
    const store = this.stores.get(msg.keyPrefix);
    if (!store) {
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: storeMissingError(msg.keyPrefix),
      } satisfies ClusterPrimaryMessage);
      return;
    }
    try {
      const result = await store.increment(msg.key, msg.options);
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: true,
        data: {
          totalHits: result.totalHits,
          remaining: result.remaining,
          resetTime: result.resetTime.toISOString(),
          isBlocked: result.isBlocked,
        },
      } satisfies ClusterPrimaryMessage);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: message,
      } satisfies ClusterPrimaryMessage);
    }
  }

  private async handleDecrement(
    worker: Worker,
    msg: Extract<ClusterWorkerMessage, { type: 'decrement' }>
  ): Promise<void> {
    const store = this.stores.get(msg.keyPrefix);
    if (!store) {
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: storeMissingError(msg.keyPrefix),
      } satisfies ClusterPrimaryMessage);
      return;
    }
    try {
      await store.decrement(msg.key, msg.options);
      worker.send({
        channel: CHANNEL,
        type: 'ack',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
      } satisfies ClusterPrimaryMessage);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: message,
      } satisfies ClusterPrimaryMessage);
    }
  }

  private async handleReset(
    worker: Worker,
    msg: Extract<ClusterWorkerMessage, { type: 'reset' }>
  ): Promise<void> {
    const store = this.stores.get(msg.keyPrefix);
    if (!store) {
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: storeMissingError(msg.keyPrefix),
      } satisfies ClusterPrimaryMessage);
      return;
    }
    try {
      await store.reset(msg.key);
      worker.send({
        channel: CHANNEL,
        type: 'ack',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
      } satisfies ClusterPrimaryMessage);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: message,
      } satisfies ClusterPrimaryMessage);
    }
  }

  private async handleShutdown(
    worker: Worker,
    msg: Extract<ClusterWorkerMessage, { type: 'shutdown' }>
  ): Promise<void> {
    const store = this.stores.get(msg.keyPrefix);
    if (!store) {
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: storeMissingError(msg.keyPrefix),
      } satisfies ClusterPrimaryMessage);
      return;
    }
    try {
      await store.shutdown();
      this.stores.delete(msg.keyPrefix);
      worker.send({
        channel: CHANNEL,
        type: 'ack',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
      } satisfies ClusterPrimaryMessage);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      worker.send({
        channel: CHANNEL,
        type: 'result',
        id: msg.id,
        keyPrefix: msg.keyPrefix,
        success: false,
        error: message,
      } satisfies ClusterPrimaryMessage);
    }
  }

  private tearDown(): void {
    if (this.listening) {
      cluster.off('message', this.messageListener);
      this.listening = false;
    }
    // Note: does not await dispatchSerial — in-flight handlers will fail gracefully when stores are cleared.
    // Awaiting would require tearDown to be async, complicating the destroy() API.
    for (const store of this.stores.values()) {
      void store.shutdown();
    }
    this.stores.clear();
  }

  /** For testing: tear down the singleton */
  static destroy(): void {
    if (!ClusterStorePrimary.instance) return;
    ClusterStorePrimary.instance.tearDown();
    ClusterStorePrimary.instance = null;
  }
}
