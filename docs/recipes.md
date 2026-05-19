# Recipes

Short integration notes for common deployments. For a full HTML symbol index, clone the repo, run **`npm install`** (pulls **`typedoc`** as a devDependency), then **`npm run docs:api`** — output is written to **`docs/api/`** (gitignored). The published **npm** package includes this file and **`typedoc.json`** but not pre-built HTML.

## NestJS + GraphQL

**Goal:** Apply `RateLimitGuard` to GraphQL resolvers with correct `req` / `res` for headers and key extraction.

1. **Peers:** `@nestjs/graphql` (and your driver: Apollo, Mercurius, etc.) — already listed as optional in the package README.
2. **Module:** Register `RateLimitModule.forRoot` / `forRootAsync` as usual. The guard detects `context.getType() === 'graphql'` and uses `GqlExecutionContext` when available (`tryResolveGraphqlRequestResponse` in `ratelimit-flex/nestjs`).
3. **Custom wiring:** If your GraphQL stack does not expose the HTTP request the default helper expects, provide **`getRequestResponse`** on `forRoot` options to return `{ req, res }` from `ExecutionContext` (see `NestRateLimitModuleOptions` in `src/nestjs/types.ts`).
4. **Keys:** Prefer **`keyGenerator(context)`** with `ExecutionContext` — e.g. user id from GraphQL context or `gqlInfo` — instead of raw IP when users sit behind the same gateway.

See [README — NestJS](../README.md#nestjs) and **NestJS: limitations** (shared engine / strategy).

## Express + reverse proxy (`trust proxy`)

**Goal:** `defaultKeyGenerator` and `req.ip` reflect the **client**, not the load balancer.

1. Set Express **`trust proxy`** before rate limit middleware, e.g. `app.set('trust proxy', 1)` or a subnet list that matches your infra ([Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html)).
2. Ensure your proxy forwards **`X-Forwarded-For`** (or your chosen header) consistently.
3. If IP is still wrong or shared NAT is an issue, set a custom **`keyGenerator`** (session, API key, JWT subject).

See [Client IP & reverse proxies](../README.md#client-ip-and-reverse-proxies).

## Hono on Cloudflare Workers

**Goal:** Run `rateLimiter` / `queuedRateLimiter` on Workers with realistic expectations.

1. **Imports:** Use `ratelimit-flex/hono` from a Workers bundle; ensure `hono` peer is satisfied by your bundler (Vite, Wrangler, etc.).
2. **Identity:** Default `honoDefaultKeyGenerator` uses `x-forwarded-for` / `x-real-ip`. Cloudflare sets **`CF-Connecting-IP`** — consider a custom **`keyGenerator`** that reads `c.req.header('CF-Connecting-IP')` (and falls back for local dev).
3. **Redis / I/O:** A TCP **`RedisStore`** is only appropriate if your Worker runtime supports outbound Redis (some do via **Hyperdrive** or similar). Otherwise use **`MemoryStore`** knowing limits are per isolate, or a HTTP-compatible store if you add one.
4. **Lifecycle:** For non-blocking work after the response (e.g. custom rollback patterns), Cloudflare’s **`executionCtx.waitUntil`** may be available on the execution context — see [Hono limitations](../README.md#hono-limitations) in the README and `HonoRateLimitOptions` JSDoc in the source tree.

**Hono:** Pass **`skipFailedRequests` / `skipSuccessfulRequests`** to **`rateLimiter()`** (v3.0.0+), or use the manual **`await next()`** + **`store.decrement`** pattern from the README if you need extra control.

5. **`queuedRateLimiter`** on Workers **does not persist** FIFO waiters beyond the isolate lifecycle — Cloudflare **evicts** isolates arbitrarily; callers should tolerate **burst 503 / shutdown errors** surfaced by **`RateLimiterQueue.shutdown()`** semantics. Prefer **`rateLimiter`** (reject fast) unless you deliberately accept backlog loss.

6. **WebSockets** — `webSocketLimiter` runs before the handshake; pairing with **`upgradeWebSocket`** must respect host runtime limits (**subrequest counts**, **`waitUntil`** for decrement rollbacks identical to HTTP).

## NestJS: different algorithms per boundary

Today **`RateLimitModule.forRoot*`** configures **one** global **`RateLimitEngine`** strategy (`RateLimitStrategy` enum). Patterns when you genuinely need mismatched algorithms:

| Approach | Fit |
|-----------|-----|
| **Split deployable / service boundary** | Simplest when auth API needs **fixed window** but public API needs **token bucket** presets. |
| **Programmatic `RateLimitEngine`** (`createRateLimitEngine`) | Outbound queues, batch jobs, cron—**not** the NestHTTP guard. |

For most HTTP surfaces, unify on **sliding window** + differentiated **`incrementCost`**/`store` rather than juggling multiple Nest strategies inside one runtime.

See [NestJS README section](../README.md#nestjs-per-route-configuration).

## KeyManager admin — hardening patterns

Combine **`createAdminRouter(keyManager, { auth: … })`** (or **`fastifyAdminPlugin`**) with defense-in-depth:

1. **Network policy** — publish admin routers on **private interfaces** only; terminate **mTLS**/OIDC **before** traffic reaches Node when possible.
2. **App-level choke** — mount a secondary **`expressRateLimiter({ maxRequests: 30, windowMs: 60_000, skip })`** scoped to `/admin/**` so scripted discovery pays immediately.
3. **JWT middleware** — `auth: { type: 'middleware', handler }` should validate **issuer, audience, expiry slack, scope** centrally; bearer tokens rotate via secret manager—not git.
4. **Never ship `unsafe-no-auth` outside notebooks** (`acknowledgeRisk: true`).