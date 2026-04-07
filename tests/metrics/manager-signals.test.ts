import { afterEach, describe, expect, it, vi } from 'vitest';

import { MetricsManager } from '../../src/metrics/manager.js';

describe('MetricsManager shutdownOnProcessExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes SIGINT/SIGTERM listeners on shutdown', async () => {
    const off = vi.spyOn(process, 'off');
    const m = new MetricsManager({ enabled: true, shutdownOnProcessExit: true });
    await m.shutdown();
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});
