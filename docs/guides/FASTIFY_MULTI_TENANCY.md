# Fastify: encapsulation, prefixes, tenant isolation

`fastify-rate-limiter`-style ergonomics hinge on **`fastify-plugin` metadata**:

1. **`fastify-plugin` wrapper**: export your plugin with `fp(yourLimiter, { name: '@org/tenant-limit', encapsulate: true })` **only if** each tenant subtree must isolate hooks; otherwise omit encapsulation **only after** validating duplicate hook registration semantics.
2. **Route prefixes**: register `fastify.register(routes, { prefix: '/t/:tenantSlug' })` *before* attaching `ratelimit-flex/fastify`:
   ```ts
   app.register(rateLimiterMw, async (scoped) => {
     scoped.register(fastifyRateLimiter({ ... tenant-specific options ... }));
     scoped.register(restOfRoutes); // inherits prefix + hooks
   });
   ```
3. **Per-tenant Redis keyspace**: derive `keyGenerator` so each tenant is part of the key, for example:
   ```ts
   keyGenerator: (req) => `${tenantId}:${req.ip}`;
   ```
   Also set distinct **`keyPrefix`** on each Redis store if multiple tenants share clusters (see **`docs/redis/SHARED_REDIS_NAMESPACE.md`** companion note below—same semantics as Postgres/Mongo TTL docs).
