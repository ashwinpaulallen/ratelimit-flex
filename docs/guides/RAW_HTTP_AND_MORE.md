# Using **`RateLimitEngine`** without Express/Fastify

```ts
import { createRateLimitEngine } from 'ratelimit-flex';
import http from 'node:http';

const engine = createRateLimitEngine({
  windowMs: 60_000,
  maxRequests: 100,
  store: redisStoreReady,
});

const server = http.createServer(async (req, res) => {
  const key = deriveKeyFromIncomingMessage(req); // pseudo
  const r = await engine.consumeWithKey(key, req);
  if (r.isBlocked) {
    res.statusCode = 429;
    res.end(JSON.stringify({ error: 'slow down' }));
    return;
  }
  res.statusCode = 200;
  res.end('ok');
});
```

**Koa** / **Elysia**: wrap **`engine.consume`** from the outermost middleware—the engine is framework-agnostic. For queue semantics call **`QueuedRateLimiterQueue`** instead of awaiting headers.
