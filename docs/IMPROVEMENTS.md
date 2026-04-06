# ratelimit-flex — improvement backlog

Maintainer-facing **residual ideas** and **design tradeoffs**. Not end-user documentation.

**Context:** Node ≥ 20, ESM-first + CJS build, adapters (Express, Fastify, NestJS, Hono), Redis + in-memory stores, composition, queues, metrics, Key Manager, In-Memory Shield.

---

## 1. Executive summary

**Recent releases (see `CHANGELOG.md`):** **v3.0.0** removed Nest **`global`**, added **`KeyedRateLimiterQueue`**, and added Hono **`skipFailedRequests` / `skipSuccessfulRequests`** (post-**`await next()`**, status via **`resolvedHonoRollbackStatus`** — not raw **`c.res.status`** alone). Earlier backlog items (composed-store branding, Nest guard/fingerprint/strategy, cluster IPC versioning, docs, tests, etc.) are documented in the changelog and git history.

**Residual notes:** **Hono** — non‑HTTP rollback rules still need a custom middleware (README **Hono → Limitations**). **Queues** — **`KeyedRateLimiterQueue`** uses simple LRU; exotic fairness stays in app code.

---

## 2. Strengths to preserve

| Area | Why it matters |
|------|----------------|
| **Pure header layer** (`formatRateLimitHeaders`, `resolveHeaderConfig`) | RFC/draft changes stay isolated from frameworks. |
| **`RateLimitEngine` as orchestrator** | Single place for allow/block, Key Manager, penalty, rollback, grouped windows, metrics. |
| **`RedisLikeClient` abstraction** | Non–ioredis clients can be adapted. |
| **Tradeoff docs** in README + JSDoc | Queue HoL, Hono caveats, Nest limitations — keep in sync with code. |
| **Vitest split** (unit vs cluster `forks`) | Matches Node `cluster` + worker constraints. |
| **Optional peers** | Lean installs per adapter. |

---

## 3. Open improvements

*None required right now.* File or restore items here when new gaps appear.

---

## 4. Tradeoffs (ongoing)

| Decision | Benefit | Cost / note |
|----------|---------|----------------|
| In-memory **penalty box** | Fast, no extra Redis round-trips | Not replicated across instances |
| **Per-handler** Nest engines **+ fingerprint** | Correct engine when merged options change | Extra engines if metadata churns at runtime (unusual) |
| **Brand / unwrap / facade** for `ComposedStore` | Minification-safe | Slightly more API surface than name checks |
| **Optional peers** | Lean installs | Occasional “forgot peer” support questions |
| **Hono skip** via **`await next()`** + **`resolvedHonoRollbackStatus`** | Parity with Express/Fastify; missing/invalid **`c.res`** / status → **200** | Non‑HTTP rollback rules (body shape, etc.) need app middleware |
| **Single FIFO** in `RateLimiterQueue` | Simple semantics | Cross-key head-of-line blocking |
| **Lua in Redis** | Atomic fairness | Redis-specific; pure REST caches differ |

---

## 5. Suggested prioritization

| Tier | Item |
|------|------|
| — | *No P0/P1 backlog items at this time.* |

---

## 6. Non-goals (unless scope changes)

- **Distributed penalty box** without an external store — overlaps Key Manager / Redis patterns.
- **Guaranteed** edge parity with Node for every feature (queues, cluster, full Redis Lua) — platform limits apply.

---

## 7. Changelog for this document

| Date | Summary |
|------|---------|
| 2026-04-06 | Initial backlog from codebase review. |
| 2026-04-06 | §3.13 Testing/CI gaps closed (composed-store minified name, Nest route-engine fingerprint regression, clamp property-style tests). |
| 2026-04-06 | §3.14 Deprecations: `global` removal scheduled v3.0.0; CHANGELOG + README codemod + JSDoc. |
| 2026-04-06 | **Rewrite:** dropped resolved §3.1–§3.14 narratives; backlog = v3 `global` removal, optional keyed-queue helper, Hono hooks. |
| 2026-04-06 | **v3.0.0 shipped:** `global` removed, **`KeyedRateLimiterQueue`**, Hono **`skipFailed*`**; open backlog cleared. |
| 2026-04-06 | Hono **`resolvedHonoRollbackStatus`** — normalize **`0`** / invalid **`c.res.status`** for skip rollback (see §1 / §4). |
| 2026-04-06 | §1 / §4: align exec summary with **`resolvedHonoRollbackStatus`**; optional **`c.res`**; JSDoc public; tradeoff row clarified. |

When an item ships, **delete or shrink** its subsection here and record it in **`CHANGELOG.md`**.
