import { describe, expect, it } from 'vitest';
import { percentileQuick, percentilesQuick } from '../../src/metrics/stats.js';

describe('percentilesQuick', () => {
  it('matches separate percentileQuick calls for the same samples', () => {
    const samples = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const ps = [50, 95, 99] as const;
    const multi = percentilesQuick(samples, ps);
    for (let i = 0; i < ps.length; i++) {
      expect(multi[i]).toBe(percentileQuick(samples, ps[i]!));
    }
  });

  it('returns zeros when samples are empty', () => {
    expect(percentilesQuick([], [50, 95, 99])).toEqual([0, 0, 0]);
  });
});
