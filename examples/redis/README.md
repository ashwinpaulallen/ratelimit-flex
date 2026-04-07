# Redis client examples (`RedisStore`)

These snippets are **documentation only**. They are **not** published packages and **not** covered by semver guarantees—copy into your app and adjust imports / versions.

`RedisStore` needs a client that implements **`RedisLikeClient`**: `get`, `set`, **`eval(script, numKeys, ...keysAndArgs)`** (ioredis-style: keys first, then argv), optional `del` / `quit` / `disconnect`. See [`src/stores/redis-store.ts`](../../src/stores/redis-store.ts).

Built-in adapters:

- **`adaptIoRedisClient`** — ioredis-style `eval(script, numKeys, ...args)`
- **`adaptNodeRedisClient`** — `@redis/client` (node-redis v4+) `eval(script, { keys, arguments })`

## `ioredis` (peer used by `url` option)

```ts
import Redis from 'ioredis';
import { RedisStore, RateLimitStrategy, adaptIoRedisClient } from 'ratelimit-flex';

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  client: adaptIoRedisClient(new Redis(process.env.REDIS_URL!)),
});
```

## `@redis/client` (node-redis)

Install: `npm install redis`. Connect once per process (or pool) and reuse.

```ts
import { createClient } from 'redis';
import { RedisStore, RateLimitStrategy, adaptNodeRedisClient } from 'ratelimit-flex';

const raw = createClient({ url: process.env.REDIS_URL });
await raw.connect();

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  client: adaptNodeRedisClient(raw),
});
```

## Bun (`RedisClient`)

Bun’s client does not match **`RedisLikeClient`** directly; route **`EVAL`** through **`send`** (RESP). Requires Bun’s Redis bindings (see [Bun Redis docs](https://bun.sh/docs/api/redis)).

```ts
import { RedisClient } from 'bun';
import type { RedisLikeClient } from 'ratelimit-flex';
import { RedisStore, RateLimitStrategy } from 'ratelimit-flex';

function adaptBunRedisEval(client: RedisClient): Pick<RedisLikeClient, 'eval'> {
  return {
    eval: (script, numKeys, ...keysAndArgs) => {
      const keys = keysAndArgs.slice(0, numKeys).map(String);
      const args = keysAndArgs.slice(numKeys).map(String);
      return client.send('EVAL', [script, String(numKeys), ...keys, ...args]);
    },
  };
}

export function adaptBunRedisClient(client: RedisClient): RedisLikeClient {
  const e = adaptBunRedisEval(client);
  return {
    get: (k) => client.get(k),
    set: (k, v, ...rest) => client.set(k, v, ...rest),
    eval: e.eval,
    del: async (...keys) => {
      if (keys.length === 0) return;
      await client.send('DEL', keys.map(String));
    },
    quit: () => client.close(),
    disconnect: () => {
      client.close();
    },
  };
}

const bunClient = new RedisClient(process.env.REDIS_URL);
await bunClient.connect();

const store = new RedisStore({
  strategy: RateLimitStrategy.SLIDING_WINDOW,
  windowMs: 60_000,
  maxRequests: 100,
  client: adaptBunRedisClient(bunClient),
});
```

Adjust **`close` / `connect`** naming against your Bun version’s typings.

## Upstash (`@upstash/redis`)

**Not** a generic key-only REST product—**`RedisStore` requires Lua `EVAL`** on a Redis-compatible endpoint.

The **`@upstash/redis`** SDK exposes **`eval(script, keys, args)`** (arrays). Map ioredis-style **`eval(script, numKeys, ...keysThenArgs)`** by slicing **`keysThenArgs`** into KEYS vs ARGV, then implement **`get` / `set` / optional `del`** to match **`RedisLikeClient`**. Validate against the SDK version you install—method names and option bags differ between releases.

## Serverless, pooling, and `EVAL` vs `EVALSHA`

- **`RedisStore`** always calls **`client.eval(fullLuaSource, …)`** per quota operation (see `evalScript` in the source). The package does **not** maintain script SHA hashes itself.
- Many clients **optimize** repeated `EVAL` into **`EVALSHA`** after the script is cached on the server—**inside the client**, not in ratelimit-flex.
- **Short-lived processes** (cold Lambda, per-request clients) pay repeated script upload until Redis caches the script; prefer **one reused client** per warm instance when possible.
- **Connection pools**: reuse clients from the pool; each store should use a **stable** client instance for the process lifetime where practical.
