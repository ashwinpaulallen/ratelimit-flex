import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/resilience/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts CLOSED', () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe('CLOSED');
    expect(cb.canAttempt()).toBe(true);
  });

  it('stays CLOSED under failure threshold', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    expect(cb.state).toBe('CLOSED');
    cb.recordFailure();
    expect(cb.state).toBe('CLOSED');
  });

  it('opens after threshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('CLOSED');
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
  });

  it('canAttempt returns false when OPEN and recovery time has not elapsed', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeMs: 5000,
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
    expect(cb.canAttempt()).toBe(false);
    vi.advanceTimersByTime(4999);
    expect(cb.canAttempt()).toBe(false);
  });

  it('transitions to HALF_OPEN after recovery time on canAttempt', () => {
    const onHalfOpen = vi.fn();
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeMs: 5000,
      onHalfOpen,
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');

    vi.advanceTimersByTime(5000);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.state).toBe('HALF_OPEN');
    expect(onHalfOpen).toHaveBeenCalledTimes(1);
  });

  it('closes on success in HALF_OPEN', () => {
    const onClose = vi.fn();
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeMs: 5000,
      onClose,
    });
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.state).toBe('HALF_OPEN');

    cb.recordSuccess();
    expect(cb.state).toBe('CLOSED');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cb.canAttempt()).toBe(true);
  });

  it('re-opens on failure in HALF_OPEN', () => {
    const onOpen = vi.fn();
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeMs: 5000,
      onOpen,
    });
    cb.recordFailure();
    cb.recordFailure();
    onOpen.mockClear();

    vi.advanceTimersByTime(5000);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.state).toBe('HALF_OPEN');

    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onOpen when circuit opens from CLOSED', () => {
    const onOpen = vi.fn();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeMs: 10_000,
      onOpen,
    });
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('calls onOpen, onHalfOpen, and onClose in sequence on open → recover → success', () => {
    const events: string[] = [];
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeMs: 1000,
      onOpen: () => events.push('open'),
      onHalfOpen: () => events.push('halfOpen'),
      onClose: () => events.push('close'),
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(events).toEqual(['open']);
    vi.advanceTimersByTime(1000);
    cb.canAttempt();
    expect(events).toEqual(['open', 'halfOpen']);
    cb.recordSuccess();
    expect(events).toEqual(['open', 'halfOpen', 'close']);
  });

  it('reset() returns to CLOSED', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
    cb.reset();
    expect(cb.state).toBe('CLOSED');
    expect(cb.canAttempt()).toBe(true);
  });

  it('success in CLOSED resets failure counter', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe('CLOSED');
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
  });

  it('HALF_OPEN respects halfOpenMaxProbes for concurrent canAttempt', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeMs: 1000,
      halfOpenMaxProbes: 2,
    });
    cb.recordFailure();
    vi.advanceTimersByTime(1000);

    expect(cb.canAttempt()).toBe(true);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.canAttempt()).toBe(false);
    expect(cb.state).toBe('HALF_OPEN');
  });

  it('destroy clears state like reset', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.state).toBe('OPEN');
    cb.destroy();
    expect(cb.state).toBe('CLOSED');
  });
});
