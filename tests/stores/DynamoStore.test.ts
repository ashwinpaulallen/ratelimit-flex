/**
 * {@link DynamoStore} runs the shared {@link runStoreComplianceTests} suite against DynamoDB Local.
 *
 * Runs when **`CI`**, **`DYNAMO_STORE_TEST=1`**, or **`DYNAMO_TEST_ENDPOINT`** is set (see `dynamo-test-backend.ts`).
 * Otherwise skipped so local `npm test` does not require Docker.
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe } from 'vitest';
import { DynamoStore, dynamoStoreTableSchema } from '../../src/stores/dynamo/index.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { runStoreComplianceTests } from './compliance.js';
import type { StoreComplianceConfig } from './compliance.js';
import {
  clearDynamoRateLimitsTable,
  initDynamoStoreTestBackend,
  runDynamoStoreIntegration,
} from './dynamo-test-backend.js';

const TABLE = 'rate_limits';

describe.skipIf(!runDynamoStoreIntegration)(
  'DynamoStore',
  { timeout: 180_000 },
  () => {
    let raw: DynamoDBClient;
    let client: DynamoDBDocumentClient;
    let cleanup: () => Promise<void> = async () => {};

    beforeAll(async () => {
      const backend = await initDynamoStoreTestBackend();
      cleanup = backend.cleanup;
      raw = new DynamoDBClient({
        endpoint: backend.endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      client = DynamoDBDocumentClient.from(raw);
      try {
        await raw.send(new CreateTableCommand(dynamoStoreTableSchema));
      } catch (e) {
        if (!(e instanceof ResourceInUseException)) {
          throw e;
        }
      }
    }, 120_000);

    afterAll(async () => {
      try {
        await raw.send(new DeleteTableCommand({ TableName: TABLE }));
      } catch {
        /* table may already be deleted */
      }
      await cleanup();
    });

    runStoreComplianceTests({
      name: 'DynamoStore',
      /**
       * DynamoDB sliding window uses a weighted sub-window model (~10% max error at boundaries).
       * The harness relaxes sliding-window **numeric** assertions accordingly; fixed window and token bucket stay exact.
       */
      slidingWindowTolerance: 0.1,
      /**
       * AWS SDK has internal timers that don't respect vi.useFakeTimers(), so use real delays.
       */
      useRealTimers: true,
      /** Weighted sliding is approximate — exact boundary / aged-hit scenarios are not asserted here. */
      skipExactSlidingWindowTimingTests: true,
      async createStore(config: StoreComplianceConfig) {
        if (config.strategy === RateLimitStrategy.TOKEN_BUCKET) {
          return new DynamoStore({
            client,
            tableName: TABLE,
            strategy: RateLimitStrategy.TOKEN_BUCKET,
            tokensPerInterval: config.tokensPerInterval,
            interval: config.interval,
            bucketSize: config.bucketSize,
          });
        }
        return new DynamoStore({
          client,
          tableName: TABLE,
          strategy: config.strategy,
          windowMs: config.windowMs,
          maxRequests: config.maxRequests,
        });
      },
      async afterEach() {
        await clearDynamoRateLimitsTable(client, TABLE);
      },
    });
  },
);
