/**
 * Typed labels for documenting **lifecycle** moments in diagrams and custom middleware instrumentation.
 *
 * @description **`ratelimit-flex` middleware does not call hooks for these phases** — this union exists so
 * custom middleware authors, OpenTelemetry exporters, or internal tooling can correlate events with the
 * sequence diagrams in `docs/OPERATIONAL_SEQUENCES.md` without copy-pasting string literals everywhere.
 *
 * @see docs/OPERATIONAL_SEQUENCES.md
 * @since 4.2.0
 */
export type RateLimitMiddlewareDiagramPhase =
  | 'middleware.enter'
  | 'engine.key-resolved'
  | 'engine.pre-store-increment'
  | 'store.increment'
  | 'engine.post-consume'
  | 'middleware.respond-blocked'
  | 'middleware.rollback-after-response';
