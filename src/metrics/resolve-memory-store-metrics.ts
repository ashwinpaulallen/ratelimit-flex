import { COMPOSED_UNWRAP } from '../composition/composed-store-brand.js';

/** Return value shape of {@link MemoryStore.getMetrics}. */
function isMemoryStoreGetMetricsResult(
  m: unknown,
): m is { activeKeys: number; totalEvictions: number; maxKeys: number } {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as { activeKeys: unknown }).activeKeys === 'number' &&
    typeof (m as { totalEvictions: unknown }).totalEvictions === 'number' &&
    typeof (m as { maxKeys: unknown }).maxKeys === 'number'
  );
}

/**
 * Walks {@link COMPOSED_UNWRAP} chains (e.g. {@link InMemoryShield}) until a store whose
 * `getMetrics()` returns MemoryStore-shaped data is found — so inner {@link MemoryStore}
 * metrics are visible when the engine store is a shield wrapper.
 *
 * @since 4.1.0
 */
export function resolveMemoryStoreMetricsSnapshot(store: unknown):
  | Readonly<{
      readonly activeKeys: number;
      readonly totalEvictions: number;
      readonly maxKeys: number;
    }>
  | undefined {
  let cur: unknown = store;
  for (let d = 0; d < 16; d++) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    const cand = cur as { getMetrics?: () => unknown };
    if (typeof cand.getMetrics === 'function') {
      const m = cand.getMetrics();
      if (isMemoryStoreGetMetricsResult(m)) {
        return Object.freeze({
          activeKeys: m.activeKeys,
          totalEvictions: m.totalEvictions,
          maxKeys: m.maxKeys,
        });
      }
    }
    const unw = (cur as { [COMPOSED_UNWRAP]?: () => unknown })[COMPOSED_UNWRAP];
    if (typeof unw !== 'function') {
      return undefined;
    }
    cur = unw.call(cur);
  }
  return undefined;
}
