# Contributing to ratelimit-flex

## Setup

```bash
git clone https://github.com/ashwinpaulallen/ratelimit-flex.git
cd ratelimit-flex
npm install
npm test
npm run build
npm run lint
```

## Guidelines

1. **Scope** — One logical behavior change per PR when possible (docs-only PRs welcome).
2. **Tests** — `npm test`; integration folders under `tests/` may require env flags (**`PG_STORE_TEST`**, **`MONGO_STORE_TEST`**, **`DYNAMO_STORE_TEST`**) mirrored in [.github/workflows/ci.yml](.github/workflows/ci.yml).
3. **Lint/format** — `npm run lint` and `npm run format:check` should pass (or run `npm run format`).
4. **CHANGELOG** — Add a concise entry under [CHANGELOG.md](CHANGELOG.md) unless the PR is typo-only (**maintainers may opt out during release prep**).
5. **Docs** — If behavior changes semantics, README or **`docs/`** deserve a sibling update (migration notes go to **`docs/MIGRATION.md`** when breaking).

### Typedoc (`npm run docs:api`)

- Run **`npm run docs:api`** to regenerate **`docs/api/index.html`** (full symbol index). Mention cross-links in **`@see`** JSDoc using relative module paths (`../headers/…`) where it helps reviewers jump from prose to symbols.


### Test matrix

| Category | Typical path | Requirements |
|---------|---------------|---------------|
| Unit | Vitest suites under **`tests/**/*.test.ts`** | None |
| Store integration | **Postgres / Mongo / Dynamo** store tests | Testcontainers Docker + env flags CI sets |
| Queuing / middleware | **`tests/middleware/**`**, **`tests/hono/**`**, **`tests/fastify.test.ts`** | None |

Branch naming is flexible; referencing an issue (**`fixes #123`**) in the PR body helps changelog writers.
