# ratelimit-flex — improvement backlog

Maintainer-facing **future work** and **design tradeoffs**. Not end-user documentation.

**Context:** Node ≥ 20, ESM-first + CJS build, adapters (Express, Fastify, NestJS, Hono), Redis + in-memory stores, composition, queues, metrics, Key Manager, In-Memory Shield.

---

## 1. Executive summary

The codebase stays **layered** (engine ↔ stores ↔ HTTP ↔ headers), **typed**, and **documented**. Prior backlog items (composed-store branding, Nest guard/cache/strategy behavior, cluster IPC versioning, Redis examples, security checklist, testing gaps, `global` → `globalGuard` schedule, etc.) are **shipped**; see `CHANGELOG.md` and git history rather than repeating them here.

**Remaining themes:** (1) **Breaking v3** — drop deprecated Nest **`global`**. (2) **Optional product** — bounded **multi-key queue** story (LRU / cap) called out in README but not in core. (3) **Hono** — first-class status-based rollback only when **portable** upstream hooks exist.

---

## 2. Strengths to preserve

| Area | Why it matters |
|------|----------------|
| **Pure header layer** (`formatRateLimitHeaders`, `resolveHeaderConfig`) | RFC/draft changes stay isolated from frameworks. |
| **`RateLimitEngine` as orchestrator** | Single place for allow/block, Key Manager, penalty, rollback, grouped windows, metrics. |
| **`RedisLikeClient` abstraction** | Non–ioredis clients can be adapted. |
| **Tradeoff docs** in README + JSDoc | Queue HoL, Hono limitations, Nest limitations — keep in sync with code. |
| **Vitest split** (unit vs cluster `forks`) | Matches Node `cluster` + worker constraints. |
| **Optional peers** | Lean installs per adapter. |

---

## 3. Open improvements

### 3.1 Breaking: remove `NestRateLimitModuleOptions.global` (v3.0.0)

**State:** Deprecated in favor of **`globalGuard`**; removal **scheduled for v3.0.0** (`CHANGELOG.md`, README **NestJS: `globalGuard`**, JSDoc codemod).

**Work:** Delete **`global`** from `NestRateLimitModuleOptions` and from **`RateLimitModule.forRootAsync`** options; remove **`resolveRegisterGlobal`** branches that read **`opts.global`**; major version + migration note only (no behavior change for migrated apps).

---

### 3.2 Optional: bounded multi-key request queues

**State:** README **Request queuing** notes that a **`Map<string, RateLimiterQueue>`** is unbounded; suggests **LRU eviction** or explicit caps in app code and says a **future helper** could wrap the pattern.

**Work (if desired in core):** e.g. `KeyedRateLimiterQueue` or a small recipe module with LRU-over-keys and documented memory bounds — or keep as README-only if scope stays minimal.

---

### 3.3 Hono: status-based skip (blocked on ecosystem)

**State:** No Express/Fastify-style **`skipFailedRequests` / `skipSuccessfulRequests`** in the Hono adapter; README documents **`await next()`** + **`store.decrement`** workaround (`src/hono/rateLimiter.ts` JSDoc).

**Work:** Revisit only when Hono (or a supported middleware contract) exposes a **portable** post-response or equivalent hook across Node and edge; until then, avoid runtime-specific `onResponse` hacks in core.

---

## 4. Tradeoffs (ongoing)

| Decision | Benefit | Cost / note |
|----------|---------|----------------|
| In-memory **penalty box** | Fast, no extra Redis round-trips | Not replicated across instances |
| **Per-handler** Nest engines **+ fingerprint** | Correct engine when merged options change | Extra engines if metadata churns at runtime (unusual) |
| **Brand / unwrap / facade** for `ComposedStore` | Minification-safe | Slightly more API surface than name checks |
| **Optional peers** | Lean installs | Occasional “forgot peer” support questions |
| **Hono** without built-in status skip | Honest, one code path | Gap vs Express until ecosystem supports it |
| **Single FIFO** in `RateLimiterQueue` | Simple semantics | Cross-key head-of-line blocking |
| **Lua in Redis** | Atomic fairness | Redis-specific; pure REST caches differ |

---

## 5. Suggested prioritization

| Tier | Item |
|------|------|
| **Next major** | §3.1 — remove **`global`** |
| **P1 (optional)** | §3.2 — bounded multi-key queue helper or official recipe |
| **Upstream-dependent** | §3.3 — Hono rollback hooks |

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

When an item ships, **delete or shrink** its subsection here and record it in **`CHANGELOG.md`**.
