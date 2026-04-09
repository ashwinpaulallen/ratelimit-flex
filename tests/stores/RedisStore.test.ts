import { RedisStore } from '../../src/stores/redis-store.js';
import { RateLimitStrategy } from '../../src/types/index.js';
import { createRedisEvalEmulator } from '../helpers/redis-eval-emulator.js';
import { runStoreComplianceTests } from './compliance.js';
import type { StoreComplianceConfig } from './compliance.js';

const testRedis = createRedisEvalEmulator();

runStoreComplianceTests({
  name: 'RedisStore',
  async createStore(config: StoreComplianceConfig) {
    if (config.strategy === RateLimitStrategy.TOKEN_BUCKET) {
      return new RedisStore({
        client: testRedis,
        strategy: RateLimitStrategy.TOKEN_BUCKET,
        tokensPerInterval: config.tokensPerInterval,
        interval: config.interval,
        bucketSize: config.bucketSize,
      });
    }
    return new RedisStore({
      client: testRedis,
      strategy: config.strategy,
      windowMs: config.windowMs,
      maxRequests: config.maxRequests,
    });
  },
  async afterEach() {
    await testRedis.flushdb();
  },
});
