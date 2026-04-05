import { describe, expect, it } from 'vitest';
import {
  capped,
  exponentialEscalation,
  fibonacciEscalation,
  fixedEscalation,
  linearEscalation,
} from '../../src/key-manager/strategies.js';

describe('penalty escalation strategies', () => {
  it('fixedEscalation returns the same value every time', () => {
    const s = fixedEscalation(5000);
    expect(s(1)).toBe(5000);
    expect(s(2)).toBe(5000);
    expect(s(99)).toBe(5000);
  });

  it('linearEscalation increases linearly', () => {
    const s = linearEscalation(1000, 250);
    expect(s(1)).toBe(1000);
    expect(s(2)).toBe(1250);
    expect(s(3)).toBe(1500);
  });

  it('exponentialEscalation doubles each time with factor 2', () => {
    const s = exponentialEscalation(1000, 2);
    expect(s(1)).toBe(1000);
    expect(s(2)).toBe(2000);
    expect(s(3)).toBe(4000);
  });

  it('fibonacciEscalation follows Fibonacci × base', () => {
    const s = fibonacciEscalation(100);
    expect(s(1)).toBe(100);
    expect(s(2)).toBe(100);
    expect(s(3)).toBe(200);
    expect(s(4)).toBe(300);
    expect(s(5)).toBe(500);
    expect(s(6)).toBe(800);
  });

  it('capped wraps any strategy with a ceiling', () => {
    const s = capped(exponentialEscalation(1000, 2), 2500);
    expect(s(1)).toBe(1000);
    expect(s(2)).toBe(2000);
    expect(s(3)).toBe(2500);
    expect(s(4)).toBe(2500);
  });
});
