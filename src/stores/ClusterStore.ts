import { randomUUID } from 'node:crypto';
import cluster from 'node:cluster';
import process from 'node:process';

import type {
  ClusterPrimaryMessage,
  ClusterStoreInitOptions,
  ClusterWorkerMessage,
} from '../cluster/protocol.js';
import { isRateLimitFlexMessage } from '../cluster/protocol.js';
import { isPm2ManagedProcess } from '../utils/environment.js';
import type {
  RateLimitDecrementOptions,
  RateLimitIncrementOptions,
  RateLimitResult,
  RateLimitStore,
  RateLimitStrategy,
} from '../types/index.js';

const CHANNEL = 'rate_limiter_flex' as const;
const INIT_TIMEOUT_MS = 30;

export interface ClusterStoreOptions {
  /** Must be unique per limiter instance across the cluster */
  keyPrefix: string;

  /** Strategy and window/bucket config — forwarded to primary's MemoryStore */
  strategy: RateLimitStrategy;
  windowMs?: number;
  maxRequests?: number;
  tokensPerInterval?: number;
  interval?: number;
  bucketSize?: number;

  /** Timeout in ms waiting for primary's response (default: 5000) */
  timeoutMs?: number;
}

type PendingIncrement = {
  kind: 'increment';
  resolve: (r: RateLimitResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingVoid = {
  kind: 'void';
  purpose: 'decrement' | 'reset' | 'shutdown';
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingEntry = PendingIncrement | PendingVoid;

function sendMessage(msg: ClusterWorkerMessage): void {
  if (typeof process.send !== 'function') {
    throw new Error('ClusterStore: process.send is not available (not a cluster worker)');
  }
  // Call process.send directly — extracting `const send = process.send` breaks the internal `this`
  // binding and throws (e.g. reading `connected` on undefined) in cluster workers.
  process.send(msg);
}

export class ClusterStore implements RateLimitStore {
  readonly keyPrefix: string;

  private readonly timeoutMs: number;

  private readonly messageHandler: (msg: unknown) => void;

  private readonly pending = new Map<string, PendingEntry>();

  private readonly _ready: Promise<void>;

  private _resolveReady!: () => void;

  private _rejectReady!: (e: Error) => void;

  private _initTimer?: ReturnType<typeof setTimeout>;

  private _readySettled = false;

  /** True once {@link shutdown} has started — blocks new operations. */
  private _shutDown = false;

  /** True after the `message` listener has been removed. */
  private _listenerRemoved = false;

  constructor(options: ClusterStoreOptions) {
    if (isPm2ManagedProcess() && !cluster.isWorker) {
      throw new Error(
        'ClusterStore is incompatible with PM2: PM2 does not use Node’s native cluster primary/worker protocol; ' +
          'it manages separate processes and uses its own IPC to the PM2 daemon. ' +
          'ClusterStore requires a real `cluster.fork()` worker and `ClusterStorePrimary` on the primary. ' +
          'Use RedisStore (or another shared RateLimitStore) for rate limits across PM2 instances.',
      );
    }
    if (!cluster.isWorker) {
      throw new Error('ClusterStore must be constructed in a cluster worker process');
    }
    if (options.keyPrefix === undefined || options.keyPrefix === '') {
      throw new Error('ClusterStore: keyPrefix is required');
    }
    if (typeof process.send !== 'function') {
      throw new Error('ClusterStore: process.send is not available (not a cluster worker)');
    }

    this.keyPrefix = options.keyPrefix;
    this.timeoutMs = options.timeoutMs ?? 5000;

    this._ready = new Promise<void>((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    this.messageHandler = (msg: unknown) => {
      this.handleIncomingMessage(msg);
    };
    process.on('message', this.messageHandler);

    this._initTimer = setTimeout(() => {
      if (this._readySettled) return;
      this.failInit(new Error(`ClusterStore: primary did not acknowledge init within ${INIT_TIMEOUT_MS}ms`));
    }, INIT_TIMEOUT_MS);

    const storeOptions = this.toStoreOptions(options);
    sendMessage({
      channel: CHANNEL,
      type: 'init',
      keyPrefix: this.keyPrefix,
      storeOptions,
    });
  }

  private toStoreOptions(options: ClusterStoreOptions): ClusterStoreInitOptions {
    return {
      strategy: options.strategy,
      windowMs: options.windowMs,
      maxRequests: options.maxRequests,
      tokensPerInterval: options.tokensPerInterval,
      interval: options.interval,
      bucketSize: options.bucketSize,
    };
  }

  private failInit(err: Error): void {
    if (this._readySettled) return;
    this._readySettled = true;
    if (this._initTimer !== undefined) {
      clearTimeout(this._initTimer);
      this._initTimer = undefined;
    }
    process.off('message', this.messageHandler);
    this._listenerRemoved = true;
    this._rejectReady(err);
  }

  private settleInit(): void {
    if (this._readySettled) return;
    this._readySettled = true;
    if (this._initTimer !== undefined) {
      clearTimeout(this._initTimer);
      this._initTimer = undefined;
    }
    this._resolveReady();
  }

  private handleIncomingMessage(msg: unknown): void {
    if (!isRateLimitFlexMessage(msg)) return;

    if (msg.type === 'init_ack') {
      if (msg.keyPrefix !== this.keyPrefix) return;
      this.settleInit();
      return;
    }

    if ('keyPrefix' in msg && msg.keyPrefix !== this.keyPrefix) return;

    if (msg.type === 'result') {
      this.dispatchResult(msg);
      return;
    }

    if (msg.type === 'ack') {
      this.dispatchAck(msg);
    }
  }

  private dispatchResult(msg: Extract<ClusterPrimaryMessage, { type: 'result' }>): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (pending.kind === 'increment') {
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.success) {
        pending.resolve({
          totalHits: msg.data.totalHits,
          remaining: msg.data.remaining,
          resetTime: new Date(msg.data.resetTime),
          isBlocked: msg.data.isBlocked,
        });
      } else {
        pending.reject(new Error(msg.error));
      }
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.success) {
      pending.reject(new Error('ClusterStore: unexpected success result for void operation'));
      return;
    }
    if (pending.purpose === 'shutdown') {
      pending.resolve();
      return;
    }
    pending.reject(new Error(msg.error));
  }

  private dispatchAck(msg: Extract<ClusterPrimaryMessage, { type: 'ack' }>): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (pending.kind !== 'void') return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    pending.resolve();
  }

  private setPending(id: string, entry: PendingEntry): void {
    const prev = this.pending.get(id);
    if (prev) {
      console.warn(`ClusterStore: overwriting pending request for duplicate id ${id}`);
      clearTimeout(prev.timer);
      prev.reject(new Error('ClusterStore: duplicate request id superseded'));
    }
    this.pending.set(id, entry);
  }

  async increment(key: string, options?: RateLimitIncrementOptions): Promise<RateLimitResult> {
    await this._ready;
    if (this._shutDown) {
      throw new Error('ClusterStore shut down');
    }

    const id = randomUUID();
    return new Promise<RateLimitResult>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`ClusterStore: primary did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.setPending(id, {
        kind: 'increment',
        resolve: (r) => {
          res(r);
        },
        reject: (e) => {
          rej(e);
        },
        timer,
      });

      sendMessage({
        channel: CHANNEL,
        type: 'increment',
        id,
        keyPrefix: this.keyPrefix,
        key,
        options: options
          ? { maxRequests: options.maxRequests, cost: options.cost }
          : undefined,
      });
    });
  }

  async decrement(key: string, options?: RateLimitDecrementOptions): Promise<void> {
    await this._ready;
    if (this._shutDown) {
      throw new Error('ClusterStore shut down');
    }

    const id = randomUUID();
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`ClusterStore: primary did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.setPending(id, {
        kind: 'void',
        purpose: 'decrement',
        resolve: () => res(),
        reject: (e) => rej(e),
        timer,
      });

      sendMessage({
        channel: CHANNEL,
        type: 'decrement',
        id,
        keyPrefix: this.keyPrefix,
        key,
        options: options?.cost !== undefined ? { cost: options.cost } : undefined,
      });
    });
  }

  async reset(key: string): Promise<void> {
    await this._ready;
    if (this._shutDown) {
      throw new Error('ClusterStore shut down');
    }

    const id = randomUUID();
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`ClusterStore: primary did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.setPending(id, {
        kind: 'void',
        purpose: 'reset',
        resolve: () => res(),
        reject: (e) => rej(e),
        timer,
      });

      sendMessage({
        channel: CHANNEL,
        type: 'reset',
        id,
        keyPrefix: this.keyPrefix,
        key,
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this._listenerRemoved) return;

    await this._ready.catch(() => undefined);

    if (this._listenerRemoved) return;

    this._shutDown = true;

    for (const [pid, p] of [...this.pending.entries()]) {
      clearTimeout(p.timer);
      p.reject(new Error('ClusterStore shut down'));
      this.pending.delete(pid);
    }

    const id = randomUUID();
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`ClusterStore: primary did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.setPending(id, {
        kind: 'void',
        purpose: 'shutdown',
        resolve: () => res(),
        reject: (e) => rej(e),
        timer,
      });

      sendMessage({
        channel: CHANNEL,
        type: 'shutdown',
        id,
        keyPrefix: this.keyPrefix,
      });
    });

    process.off('message', this.messageHandler);
    this._listenerRemoved = true;
  }
}
