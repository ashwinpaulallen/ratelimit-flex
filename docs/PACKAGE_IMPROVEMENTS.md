# Package improvements backlog

This document lists **potential enhancements** for **ratelimit-flex**, grouped to align with **[PROJECT_GUIDE_FOR_FRESHERS.md](PROJECT_GUIDE_FOR_FRESHERS.md)** (sections 1–11) plus **cross-cutting** areas (documentation, tooling, ecosystem). Items are suggestions for maintainers and contributors—not a commitment or guarantee of implementation.

Priorities are indicative: **P0** = high leverage or correctness/safety; **P1** = strong DX or ops value; **P2** = nice-to-have or niche.

**Completed P0 items** (tracked here for history): failure-mode operators’ doc ([FAILURE_MODES.md](FAILURE_MODES.md)), queued vs engine parity table ([QUEUING.md § Engine parity](QUEUING.md#engine-middleware-vs-queued-middleware-parity)), README deduplication + restored `## Choosing a strategy` / `## Configuration Reference`, **`npm run benchmark`** ([scripts/benchmark.mjs](../scripts/benchmark.mjs)).

**Completed P2 items** (bulk): consolidated guide **[docs/guides/P2_REFERENCE.md](docs/guides/P2_REFERENCE.md)** + linked artifacts (comparison table, versioning, glossary, queue priority design draft, breaker tuning, SLO Prometheus sketches, audits, playgrounds, instrumentation types, presets, soak/property/smoke helpers). Table rows carrying **`✅ Done`** in the Priority column summarize this wave.

**How to read `✅ Done`:** A row may be satisfied by **docs/recipes only** (no new export), a **partial API** (`⚠️ Partial` where noted), or a **full library feature**. For semver and release notes, treat **[P2_REFERENCE.md](guides/P2_REFERENCE.md)** as the checklist — do not assume every **`✅ Done`** row maps 1:1 to a new symbol in `src/index.ts`.

**Completed / partial P1 batch** (see table rows **`✅ Done`**, **`⚠️ Partial`**): consolidated docs (**[DEPLOYMENT_PATHS.md](DEPLOYMENT_PATHS.md)**, **[OPERATIONAL_SEQUENCES.md](OPERATIONAL_SEQUENCES.md)**, **[BENCHMARKS.md](BENCHMARKS.md)**, **[REDIS_STORE_OPERATIONS.md](REDIS_STORE_OPERATIONS.md)**), **`examples/custom-store/README.md`**, expanded **[METRICS.md](METRICS.md)** OTel/tracing cookbook + dashboards, richer store guides, **`CONTRIBUTING.md`**, **`SECURITY.md`** (**OpenSSF Scorecard** link + provenance opt-in OIDC), README documentation hub / clock skew guidance, presets **`hybridWindowsPreset`** + **`redisWithShieldPreset`** + key hygiene helpers, Dynamo sliding **`onSlidingWindowObservation`**, CI Express 4 peer job, Recipes + FAILURE/REDIS tweaks, ESLint tooling for **`scripts/**/*.mjs`**.

---

## 1. What problem does this solve? — positioning & onboarding

| Idea | Notes | Priority |
|------|------|----------|
| **Single “choose your path” page** | One flowchart or decision tree: single instance → Redis → Postgres-only → Dynamo serverless → cluster IPC. Links into presets and store docs. | **✅ Done** |
| **Compare-at-a-glance** | Short table vs `express-rate-limit`, `@fastify/rate-limit`, `limiter`-style libs: backends, algorithms, Nest/Hono, composition, shield, resilience. | **✅ Done** |
| **Version support statement** | Explicit LTS or major-version support window in README (even if informal). | **✅ Done** |

---

## 2. Mental model: one request’s journey — engine & middleware clarity

| Idea | Notes | Priority |
|------|------|----------|
| **Failure-mode matrix** | One doc table: Redis down (fail-open/closed vs insurance), shield hit vs miss, KeyManager sync lag, store `storeUnavailable`. Reduces surprises in prod. | **✅ Fixed** — see [FAILURE_MODES.md](FAILURE_MODES.md) |
| **Sequence diagrams** | Optional Mermaid diagrams for: normal path, rollback (`skip*` + decrement), queued release, Redis failover to insurance. | **✅ Done** |
| **Export minimal “diagram types”** | If useful for custom middleware authors: typed hooks for lifecycle phases (pre-key, post-increment) without copying engine internals—only if API stays minimal. | **✅ Done** |

---

## 3. The three core algorithms — correctness & features

| Idea | Notes | Priority |
|------|------|----------|
| **Dynamo sliding window** | Keep documenting approximation bounds; optionally add **confidence metrics** or **configurable sub-window count** where it improves accuracy/latency trade-offs (evaluate with benchmarks). | **⚠️ Partial —** **`onSlidingWindowObservation`** + **[stores/dynamo.md](stores/dynamo.md)** operator hook for blend/usage dashboards; configurable sub-window granularity still future work |
| **Leaky bucket (optional)** | Some teams ask for leaky bucket semantics; evaluate as alias or documented recipe if token bucket covers most cases. | **✅ Done** |
| **Hybrid window presets** | Preset that bundles “per-second burst + per-minute steady” via `compose` or `limits` with one named export and tests. | **✅ Done** |
| **Clock skew documentation** | Expand guidance: `resetTime`, `Retry-After`, multi-region Redis, and client clock skew. | **✅ Done** |

---

## 4. Stores: where state lives — backends & adapters

| Idea | Notes | Priority |
|------|------|----------|
| **Redis** | Document **connection pooling**, **cluster/sentinel** caveats, and when **EVALSHA** warming helps; optional adapter example for **Valkey**. | **✅ Done** |
| **PostgreSQL / Mongo** | Sweep docs for **index maintenance**, **vacuum/TTL** operational runbooks; add “expected QPS per row” sanity guidance. | **✅ Done** |
| **DynamoDB** | Cost/latency section: RCU/WCU assumptions, hot partition risk for very hot keys. | **✅ Done** |
| **`MemoryStore` / `ClusterStore`** | Expose optional **telemetry hook** when eviction rate exceeds threshold (complements `onEvict`). | **✅ Done** |
| **Custom `RateLimitStore`** | Scaffold **templates** repo or `examples/custom-store/` with README checklist (atomicity, cost, decrement pairing). | **✅ Done** |

---

## 5. Framework integration — Express, Fastify, NestJS, Hono

| Idea | Notes | Priority |
|------|------|----------|
| **NestJS multi-strategy** | First-class pattern for different strategies per route (multiple dynamic modules, named engines, or documented factory recipe with tests). | **✅ Done** |
| **Hono / Workers** | Expand **recipes** for `waitUntil`, WebSocket edge cases, and limits of queued mode on isolates. | **✅ Done** |
| **Fastify** | Ensure plugin **encapsulation** and **prefix** patterns are documented for multi-tenant apps. | **✅ Done** |
| **Additional frameworks** | Only if demand is clear: **Koa**, **Elysia**, or raw `http` helper built on `RateLimitEngine` to avoid duplicating logic. | **✅ Done** |

---

## 6. Major features (beyond basic limit + 429)

### 6.1 Composition

| Idea | Notes | Priority |
|------|------|----------|
| **Observability per layer** | Ensure `extractLayerMetrics` (and docs) cover all composition modes consistently; add integration test matrix. | **✅ Done** |
| **Nest layer metadata** | If feasible, surface composed layer breakdown in a standard request attachment (parity with Express `req.rateLimitComposed`). | **✅ Done** |

### 6.2 Queuing

| Idea | Notes | Priority |
|------|------|----------|
| **Parity matrix** | Single table: queued vs engine path — `draft`, KeyManager pre-checks, `rateLimitComposed`, WebSocket. Closes expectation gaps. | **✅ Fixed** — [QUEUING.md § parity](QUEUING.md#engine-middleware-vs-queued-middleware-parity) |
| **Per-key fairness** | Promote **`KeyedRateLimiterQueue`** in README as default for multi-key HTTP if FIFO global queue is a footgun. | **✅ Done** |
| **Priority queue (optional)** | Opt-in priority for paid tiers—careful with starvation; spec and tests first. | **✅ Done** |

### 6.3 Shield (`InMemoryShield`)

| Idea | Notes | Priority |
|------|------|----------|
| **Preset bundle** | `redisWithShieldPreset({ ... })` wrapping Redis + shield defaults + doc’d tunables (`maxBlockedKeys`, etc.). | **✅ Done** |
| **Double-shield lint** | Keep dev-time warning; optional **strict mode** that throws if double-wrap detected. | **✅ Done** |

### 6.4 KeyManager & admin API

| Idea | Notes | Priority |
|------|------|----------|
| **Admin hardening** | Examples for **mTLS**, **IP allowlist**, **short-lived JWT** validation in `auth: { type: 'middleware' }`. | **✅ Done** |
| **Audit export** | Optional **structured log schema** (versioned) for `onAdminAction` consumers. | **✅ Done** |
| **Rate-limit the admin router** | Document pattern: mount admin behind separate limiter + network policy. | **✅ Done** |

### 6.5 Redis resilience

| Idea | Notes | Priority |
|------|------|----------|
| **Sync semantics** | Deeper docs on insurance → Redis **replay** edge cases (sliding window time smearing called out in JSDoc—surface in user-facing doc). | **✅ Done** |
| **Breaker tuning guide** | Defaults vs high-latency Redis (larger `recoveryTimeMs`, etc.). | **✅ Done** |

### 6.6 Metrics & observability

| Idea | Notes | Priority |
|------|------|----------|
| **OTel semantic conventions** | Map internal metrics to **stable** convention names where applicable; document gaps. | **✅ Done** |
| **Tracing** | Optional spans: `rate_limit.evaluate`, `store.increment`, `redis.failover`—behind opt-in to avoid overhead. | **✅ Done** |
| **SLO helpers** | Example Grafana/Prometheus queries for block rate, store latency p95, shield hit rate. | **✅ Done** |

### 6.7 Weighted / cost-based limiting

| Idea | Notes | Priority |
|------|------|----------|
| **GraphQL / complexity** | Recipe: `incrementCost` from parsed query cost or directive. | **✅ Done** |
| **Decrement pairing tests** | Expand coverage for composed + grouped + weighted rollback paths across frameworks. | **✅ Done** — grouped **`decrementStoresAfterConsumeAsync`** + dynamic **`incrementCost`**; composed **`mode: all` / `overflow`** weighted **`decrement` (+ `matchingDecrementOptions`)** tests |

### 6.8 Headers & standards

| Idea | Notes | Priority |
|------|------|----------|
| **Multi-window header honesty** | README already notes `identifier` / policy approximation—add **copy-paste** examples for multi-window `RateLimit-Policy` text in product docs. | **✅ Done** |
| **Fuzz tests** | Header formatting with extreme `remaining` / `reset` values and invalid combinations. | **✅ Done** |

---

## 7. Presets — defaults & environments

| Idea | Notes | Priority |
|------|------|----------|
| **`serverlessRedisPreset`** | Opinionated Upstash / HTTP-Router Redis wrapper **example** (or preset if API stabilizes). | **✅ Done** |
| **`observabilityPreset`** | Merges sensible `metrics` defaults + optional shield for Redis deployments. | **✅ Done** |
| **Preset tests** | Snapshot or contract tests that presets include required security fields (e.g. admin auth not in preset by accident). | **✅ Done** — primitives scan + **`keyManager`** absence across merged presets ([tests/middleware/decrement-pairing.test.ts](../tests/middleware/decrement-pairing.test.ts) `'preset security surface'`)

---

## 8. Security and operations — abuse, keys, compliance

| Idea | Notes | Priority |
|------|------|----------|
| **Key hygiene utilities** | Opt-in helpers: `hashKey(input, maxLength)`, `normalizeIp`, safe truncation—**never** change keys silently in core. | **✅ Done** |
| **Cardinality alerts** | Doc + optional callback when `MemoryStore` eviction velocity exceeds threshold. | **✅ Done** |
| **Redis namespace checklist** | Per-tenant `keyPrefix` runbook for shared Redis clusters. | **✅ Done** |
| **Supply chain** | **npm provenance**, OpenSSF scorecard link, security policy in `SECURITY.md` if not present. | **✅ Done —** `SECURITY.md` links **[OpenSSF Scorecard viewer](https://scorecard.dev/viewer/?repo=github.com/ashwinpaulallen/ratelimit-flex)** + **`npm publish --provenance`** opt-in narrative; workflow **`--access public` only** for classic **`NPM_TOKEN`** |

---

## 9. Package layout — developer experience

| Idea | Notes | Priority |
|------|------|----------|
| **Contribution guide** | `CONTRIBUTING.md`: branch naming, test categories (unit vs integration vs testcontainers), when to update CHANGELOG. | **✅ Done** |
| **API docs hosting** | Link published TypeDoc output (GitHub Pages or npm `homepage`) from README. | **✅ Done** |
| **Deep links** | In JSDoc `@see` links to exact README anchors and `docs/*.md` paths. | **✅ Done** |

---

## 10. Glossary — documentation quality

| Idea | Notes | Priority |
|------|------|----------|
| **Expand glossary** | Terms: insurance limiter, binding window, head-of-line blocking, draft mode, `storeUnavailable`. | **✅ Done** |
| **i18n** | If community asks: export message keys or document how to wrap `message` for i18n libraries. | **✅ Done** |

---

## 11. Summary table: algorithm → when — learning materials

| Idea | Notes | Priority |
|------|------|----------|
| **Interactive playground** | Small `examples/` web app or StackBlitz template to visualize sliding vs fixed vs token bucket. | **✅ Done** |
| **Video or animated diagrams** | Link from fresher guide (external). | P3 |

---

## Cross-cutting: README & main documentation

| Idea | Notes | Priority |
|------|------|----------|
| **Remove duplicate sections** | Merge repeated **Request queuing** and **Redis resilience** blocks in README into single sections with one TOC entry. | **✅ Fixed** — [README](../README.md) (`## Choosing a strategy`, `## Configuration Reference` restored) |
| **Benchmark script** | Add `npm run benchmark` **or** remove/adjust README instructions until a harness exists. | **✅ Fixed** — `npm run benchmark` → `scripts/benchmark.mjs` + README methodology |
| **Link graph** | Ensure `docs/recipes.md`, `MIGRATION.md`, and store docs cross-link from README “Further reading” hub. | **✅ Done** |

---

## Cross-cutting: testing & quality

| Idea | Notes | Priority |
|------|------|----------|
| **Property-based tests** | For merge options and header math (bounded exploration). | **✅ Done** |
| **Soak tests** | Long-running job (CI optional) for memory leaks in queue + shield LRU. | **✅ Done** |
| **Compatibility matrix CI** | Optional job matrix: Express 4 vs 5, Fastify 4 vs 5, peer ranges. | **✅ Done** |

---

## Cross-cutting: performance & benchmarking

| Idea | Notes | Priority |
|------|------|----------|
| **Reproducible benchmark suite** | `autocannon` or similar with pinned Node + Docker Redis; publish results **methodology** in `docs/BENCHMARKS.md`. | **✅ Done** |
| **Regression gate** | Optional CI threshold with wide tolerance (flaky avoidance). | **✅ Done** |

---

## How to use this document

1. Pick a **theme** aligned with roadmap (e.g. “Nest parity”, “Redis ops”, “Observability”).
2. Convert rows into GitHub issues with **acceptance criteria** and links to affected `src/` paths.
3. After shipping, **trim or annotate** rows here—or move completed items to [CHANGELOG](../CHANGELOG.md) only.
