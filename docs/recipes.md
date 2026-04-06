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

`skipFailedRequests` / `skipSuccessfulRequests` are **not** built into the Hono adapter; use the documented **`await next()`** + `store.decrement` pattern if you need status-based rollback.
