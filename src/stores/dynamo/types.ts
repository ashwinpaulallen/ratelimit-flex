import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { RateLimitStrategy } from '../../types/index.js';

/**
 * Emitted once per successful {@link DynamoStore} **sliding window** increment (weighted sub-window estimator).
 *
 * @description Aggregate this in Prometheus/OpenTelemetry to monitor how often the estimator sits near **`cap`**,
 * how **`previousWindowBlendWeight`** evolves (boundary effects), or to alarm on unexpected **`approximateUsage`** jitter.
 *
 * This is **library-local telemetry** — it does not imply AWS metrics or DynamoDB consumed capacity.
 *
 * @see {@link DynamoStoreOptions.onSlidingWindowObservation}
 */
export interface DynamoSlidingWindowObservation {
  /** Weight applied to `previousSubwindowHits` inside {@link DynamoStore}: 1 → 0 across the active sub-window start. */
  previousWindowBlendWeight: number;
  /** Count carried from the immediately prior fixed sub-window boundary. */
  previousSubwindowHits: number;
  /** Count accrued in the current fixed sub-window. */
  currentSubwindowHits: number;
  /** Raw weighted usage before **`Math.ceil`** (same basis as blocking in {@link DynamoStore}). */
  approximateUsage: number;
  /** `Math.ceil(approximateUsage)` — aligns with `RateLimitResult.totalHits` rounding in {@link DynamoStore}. */
  roundedTotalHitsEstimate: number;
  /** Effective cap passed to {@link DynamoStore.increment} for this consume. */
  cap: number;
  windowMs: number;
  /** Same as Dynamo attribute `currentWindowStart` (epoch ms). */
  currentWindowStartMs: number;
  nowMs: number;
}

/**
 * Options for {@link DynamoStore}.
 *
 * @remarks
 * DynamoDB table and TTL must be provisioned before use — see the {@link DynamoStore} class documentation.
 */
export interface DynamoStoreOptions {
  /**
   * DynamoDB client (v3 SDK). Accept raw DynamoDBClient or
   * DynamoDBDocumentClient (preferred — handles marshalling).
   */
  client: DynamoDBClient | DynamoDBDocumentClient;

  /** Table name (must already exist; see {@link DynamoStore}). */
  tableName: string;

  /**
   * Algorithm. Default: {@link RateLimitStrategy.FIXED_WINDOW} (exact on DynamoDB), matching {@link dynamoPreset}.
   * Set {@link RateLimitStrategy.SLIDING_WINDOW} for the weighted approximate sliding model — see {@link DynamoStore}.
   */
  strategy?: RateLimitStrategy;
  windowMs?: number;
  maxRequests?: number;
  tokensPerInterval?: number;
  interval?: number;
  bucketSize?: number;

  keyPrefix?: string;

  /**
   * Name of the TTL attribute for DynamoDB's automatic expiry.
   * Default: 'ttl'. Must match the attribute configured in your
   * DynamoDB TTL settings for the table.
   */
  ttlAttribute?: string;

  onDynamoError?: 'fail-open' | 'fail-closed';
  onWarn?: (msg: string, err?: Error) => void;

  /**
   * Optional callback after each **successful** sliding-window {@link DynamoStore.increment}.
   *
   * @description Use for dashboards or structured logs describing approximation freshness (weighted blend,
   * sub-window counters). Not invoked for fixed window / token bucket, error paths, or fail-open/error fallbacks
   * that short-circuit before a committed Dynamo read/write.
   * @since 4.2.0
   */
  onSlidingWindowObservation?: (observation: DynamoSlidingWindowObservation) => void;
}
