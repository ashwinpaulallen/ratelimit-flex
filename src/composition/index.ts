/**
 * Composition API: {@link ComposedStore}, {@link compose}, per-layer types, {@link extractLayerMetrics},
 * and Redis composition presets ({@link multiWindowPreset}, {@link burstablePreset}, {@link failoverPreset}).
 *
 * @packageDocumentation
 */
export type {
  CompositionMode,
  CompositionLayer,
  ComposedLayerRow,
  ComposedIncrementResult,
  ComposedStoreOptions,
  RateLimitIncrementOptions,
} from './types.js';
export { isComposedIncrementResult } from './types.js';

export { ComposedStore } from './ComposedStore.js';
export { compose } from './compose.js';
export {
  extractLayerMetrics,
  type ComposedLayerMetricEntry,
} from './extractLayerMetrics.js';

export {
  burstablePreset,
  failoverPreset,
  multiWindowPreset,
  type BurstableRedisConfig,
  type FailoverPresetStoreEntry,
  type MultiWindowRedisWindow,
} from '../presets/composition-presets.js';
