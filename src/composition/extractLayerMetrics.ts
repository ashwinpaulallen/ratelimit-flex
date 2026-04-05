import type { ComposedIncrementResult, ComposedLayerRow } from './types.js';

/**
 * One layer’s extractable metrics row (Prometheus / OpenTelemetry labels).
 *
 * @since 2.0.0
 */
export interface ComposedLayerMetricEntry {
  layer: string;
  totalHits: number;
  remaining: number;
  isBlocked: boolean;
  consulted: boolean;
}

/**
 * Extracts per-layer metrics from a {@link ComposedIncrementResult} for Prometheus/OTel export.
 * Returns one metric entry per layer (object insertion order of {@link ComposedIncrementResult.layers}).
 *
 * @since 2.0.0
 */
function walkLayers(
  prefix: string,
  layers: Record<string, ComposedLayerRow>,
  out: ComposedLayerMetricEntry[],
): void {
  for (const [name, row] of Object.entries(layers)) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({
      layer: path,
      totalHits: row.totalHits,
      remaining: row.remaining,
      isBlocked: row.isBlocked,
      consulted: row.consulted,
    });
    if (row.innerLayers) {
      walkLayers(path, row.innerLayers, out);
    }
  }
}

export function extractLayerMetrics(result: ComposedIncrementResult): ComposedLayerMetricEntry[] {
  const out: ComposedLayerMetricEntry[] = [];
  walkLayers('', result.layers, out);
  return out;
}
