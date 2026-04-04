/** Discriminated union for worker → primary messages */
export type ClusterWorkerMessage =
  | {
      channel: 'rate_limiter_flex';
      type: 'increment';
      id: string; // unique request ID (crypto.randomUUID or counter)
      keyPrefix: string; // identifies which limiter instance
      key: string;
      options?: { maxRequests?: number; cost?: number };
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'decrement';
      id: string;
      keyPrefix: string;
      key: string;
      options?: { cost?: number };
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'reset';
      id: string;
      keyPrefix: string;
      key: string;
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'shutdown';
      id: string;
      keyPrefix: string;
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'init';
      keyPrefix: string;
      storeOptions: ClusterStoreInitOptions;
    };

/** Primary → worker response */
export type ClusterPrimaryMessage =
  | {
      channel: 'rate_limiter_flex';
      type: 'result';
      id: string;
      keyPrefix: string;
      success: true;
      data: {
        totalHits: number;
        remaining: number;
        resetTime: string; // ISO string (Date doesn't serialize over IPC)
        isBlocked: boolean;
      };
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'result';
      id: string;
      keyPrefix: string;
      success: false;
      error: string;
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'ack';
      id: string;
      keyPrefix: string;
    }
  | {
      channel: 'rate_limiter_flex';
      type: 'init_ack';
      keyPrefix: string;
    };

/** Options sent during init so primary can create the right MemoryStore */
export interface ClusterStoreInitOptions {
  strategy: string; // RateLimitStrategy value
  windowMs?: number;
  maxRequests?: number;
  tokensPerInterval?: number;
  interval?: number;
  bucketSize?: number;
}

/** Type guard: is this message on our channel? */
export function isRateLimitFlexMessage(
  msg: unknown
): msg is ClusterWorkerMessage | ClusterPrimaryMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'channel' in msg &&
    (msg as { channel: string }).channel === 'rate_limiter_flex'
  );
}
