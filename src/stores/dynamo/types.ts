import type {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { RateLimitStrategy } from '../../types/index.js';

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
}
