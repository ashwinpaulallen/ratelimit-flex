# Compare **ratelimit-flex** at a glance

| Capability | ratelimit-flex | [`express-rate-limit`](https://github.com/express-rate-limit/express-rate-limit) | [`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit) | “limiter”-style knobs |
|-----------|----------------|---------|---------|---------|
| **Express** middleware | ✅ | ✅ | ❌ | varies |
| **Fastify** plugin | ✅ `ratelimit-flex/fastify` | ❌ | ✅ | varies |
| **NestJS** module | ✅ `ratelimit-flex/nestjs` | wrappers only | wrappers only | rare |
| **Hono / Workers-aware recipes** | ✅ `ratelimit-flex/hono` + docs | ❌ | ❌ | rare |
| **Stores** | memory, Redis, Postgres, Mongo, Dynamo, IPC cluster, composed stacks | Redis / Memory (limited) mostly | Redis / memory | Redis-only frequent |
| **Algorithms** | sliding, fixed, token bucket | sliding / IP bucket strategy mix | Redis sliding window LUA | simplistic |
| **Composition** (`all`, `overflow`, failover, race / windows) | ✅ | ❌ manual | ❌ manual | ❌ |
| **In-memory shield** (hot blocked key cache on Redis) | ✅ | ❌ | ❌ | rare |
| **Redis resilience / insurance LM** | ✅ rich | limited | ❌ core | ❌ |
| **Programmatic KeyManager admin API** | ✅ hardened patterns | ❌ | ❌ | ❌ |

This table is illustrative: feature sets move—verify against each project’s README when choosing.
