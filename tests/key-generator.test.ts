import { describe, expect, it } from 'vitest';
import { defaultKeyGenerator } from '../src/strategies/rate-limit-engine.js';

describe('defaultKeyGenerator', () => {
  it('extracts req.ip when present', () => {
    expect(defaultKeyGenerator({ ip: '192.168.1.1' })).toBe('192.168.1.1');
  });

  it('extracts socket.remoteAddress when req.ip is missing', () => {
    expect(defaultKeyGenerator({ socket: { remoteAddress: '10.0.0.1' } })).toBe('10.0.0.1');
  });

  it('returns "unknown" when no IP is found', () => {
    expect(defaultKeyGenerator({})).toBe('unknown');
    expect(defaultKeyGenerator(null)).toBe('unknown');
    expect(defaultKeyGenerator(undefined)).toBe('unknown');
  });

  it('handles string input (precomputed key)', () => {
    expect(defaultKeyGenerator('user-123')).toBe('user-123');
  });

  it('ignores empty string IPs', () => {
    expect(defaultKeyGenerator({ ip: '' })).toBe('unknown');
    expect(defaultKeyGenerator({ socket: { remoteAddress: '' } })).toBe('unknown');
  });

  it('handles IPv6 addresses', () => {
    expect(defaultKeyGenerator({ ip: '::1' })).toBe('::1');
    expect(defaultKeyGenerator({ ip: '2001:db8::1' })).toBe('2001:db8::1');
  });
});
