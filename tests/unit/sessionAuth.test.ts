import { describe, it, expect } from 'vitest';
import { LockoutTracker, clientIp } from '../../src/server/sessionAuth.js';
import type { Request } from 'express';

describe('LockoutTracker', () => {
  it('blocks only after the threshold is crossed', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 4; i++) tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
    tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(true);
  });

  it('expires the block after blockMs', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 5; i++) tracker.recordFailure('1.1.1.1');
    now += 900_001;
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
  });

  it('forgets failures older than the window', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 4; i++) tracker.recordFailure('1.1.1.1');
    now += 300_001;
    tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
  });

  it('tracks IPs independently and resets on success', () => {
    const tracker = new LockoutTracker({ now: () => 0 });
    for (let i = 0; i < 5; i++) tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('2.2.2.2')).toBe(false);
    tracker.reset('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
  });

  it('reports a positive retryAfterMs while blocked', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 5; i++) tracker.recordFailure('1.1.1.1');
    expect(tracker.retryAfterMs('1.1.1.1')).toBeGreaterThan(0);
    expect(tracker.retryAfterMs('2.2.2.2')).toBe(0);
  });
});

describe('clientIp', () => {
  const req = (xff: string | undefined, socket = '10.0.0.1') =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } }) as unknown as Request;

  it('uses the socket address when not trusting a proxy', () => {
    expect(clientIp(req('9.9.9.9'), false)).toBe('10.0.0.1');
  });

  it('uses the rightmost X-Forwarded-For token when trusting a proxy', () => {
    expect(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), true)).toBe('3.3.3.3');
  });

  it('falls back to the socket address when the header is absent', () => {
    expect(clientIp(req(undefined), true)).toBe('10.0.0.1');
  });
});
