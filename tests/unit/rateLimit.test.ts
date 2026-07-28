import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/server/rateLimit.js';

describe('RateLimiter', () => {
  it('allows up to the limit then blocks inside the window', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    const blocked = limiter.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('starts a fresh window once the old one expires', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    now += 1001;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('bounds memory when sprayed with distinct keys', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 10, now: () => now });
    for (let i = 0; i < 500; i++) limiter.check(`ip-${i}`);
    expect(limiter.trackedKeys).toBeLessThanOrEqual(10);
  });

  it('reclaims expired keys rather than evicting live ones', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, maxKeys: 3, now: () => now });
    limiter.check('old-1');
    limiter.check('old-2');
    limiter.check('old-3');
    now += 1001;
    limiter.check('fresh');
    expect(limiter.trackedKeys).toBe(1);
  });
});
