import { describe, it, expect } from 'vitest';
import { LockoutTracker, clientIp, readSession, SESSION_COOKIE } from '../../src/server/sessionAuth.js';
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

describe('readSession', () => {
  const req = (payload: unknown) =>
    ({ signedCookies: { [SESSION_COOKIE]: JSON.stringify(payload) } }) as unknown as Request;

  it('accepts a well-formed, unexpired session', () => {
    expect(readSession(req({ username: 'james', userId: '1', issuedAt: Date.now() })))
      .toMatchObject({ username: 'james', userId: '1' });
  });

  it('rejects a session whose issuedAt is missing', () => {
    // Date.now() - undefined is NaN and NaN > MAX_AGE is false, so without an
    // explicit finite check the expiry test silently passes. Must fail closed.
    expect(readSession(req({ username: 'james', userId: '1' }))).toBeNull();
  });

  it('rejects a non-numeric or non-finite issuedAt', () => {
    expect(readSession(req({ username: 'james', userId: '1', issuedAt: 'yesterday' }))).toBeNull();
    expect(readSession(req({ username: 'james', userId: '1', issuedAt: null }))).toBeNull();
  });

  it('rejects an expired session', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    expect(readSession(req({ username: 'james', userId: '1', issuedAt: eightDaysAgo }))).toBeNull();
  });

  it('rejects an unsigned or absent cookie', () => {
    expect(readSession({ signedCookies: {} } as unknown as Request)).toBeNull();
    expect(readSession({} as unknown as Request)).toBeNull();
  });

  it('rejects a signed cookie that is not JSON', () => {
    expect(readSession({ signedCookies: { [SESSION_COOKIE]: 'not json' } } as unknown as Request)).toBeNull();
  });
});

describe('LockoutTracker memory', () => {
  it('prunes stale IPs so a spray of forged X-Forwarded-For cannot grow it without bound', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 2000; i++) tracker.recordFailure(`10.0.0.${i}`);
    now += 16 * 60_000;
    tracker.recordFailure('10.1.1.1');
    // Everything from the first burst is outside both the window and any block.
    expect(tracker.isBlocked('10.0.0.5')).toBe(false);
    const internals = tracker as unknown as { failures: Map<string, number[]>; blocked: Map<string, number> };
    expect(internals.failures.size).toBe(1);
    expect(internals.blocked.size).toBe(0);
  });
});
