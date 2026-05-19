# Choosing a deployment path

Use this guide to pick **`MemoryStore`**, **`ClusterStore`**, **`RedisStore`**, **PostgreSQL**, **MongoDB**, **DynamoDB**, or presets—before reading store-specific DDL.

```mermaid
flowchart TD
  A[Traffic pattern] --> B{Horizontal scale<br/>many replicas?}
  B -->|No| C{Node cluster module<br/>one host?}
  C -->|Yes| D[ClusterStore + clusterPreset]
  C -->|No| E[MemoryStore / singleInstancePreset]
  B -->|Yes| F{Dynamo-first<br/>managed serverless AWS?}
  F -->|Yes| G[DynamoStore + dynamoPreset]
  F -->|No| H{Postgres ecosystem only?}
  H -->|Yes| I[PgStore + postgresPreset]
  H -->|No| J{MongoDB already?}
  J -->|Yes| K[MongoStore + mongoPreset]
  J -->No| L[RedisStore + multiInstancePreset / resilientRedisPreset]
```

| Path | Typical setup | See also |
|------|---------------|-----------|
| **Single VM / hobby** | `singleInstancePreset` — no Redis | README *When to use MemoryStore* |
| **Many pods / VMs** | `multiInstancePreset({ url })` or **`redisWithShieldPreset`** for explicit shield sizing | README *When to use RedisStore*, [FAILURE_MODES.md](FAILURE_MODES.md) |
| **Strict outage behavior** | `resilientRedisPreset` (insurance + breaker) | [REDIS_RESILIENCE.md](REDIS_RESILIENCE.md) |
| **Node fork workers only** | `clusterPreset`, `queuedClusterPreset` — **not** PM2 fork | README *ClusterStore* |
| **No Redis**, SQL shop | `postgresPreset`, schema in [stores/postgres.md](stores/postgres.md) | [stores/postgres.md](stores/postgres.md) |
| **Mongo** | `mongoPreset`, TTL indexes | [stores/mongo.md](stores/mongo.md) |
| **AWS native** | `dynamoPreset` — note sliding-window approximation | [stores/dynamo.md](stores/dynamo.md) |

**Operational reads:** failure semantics → [FAILURE_MODES.md](FAILURE_MODES.md). Request flows → [OPERATIONAL_SEQUENCES.md](OPERATIONAL_SEQUENCES.md).
