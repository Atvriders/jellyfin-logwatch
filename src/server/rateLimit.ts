import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** Hard cap on tracked keys, so a spray of distinct IPs cannot exhaust memory. */
  maxKeys?: number;
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Fixed-window counter, keyed by client IP. Deliberately in-process and
 * dependency-free: the runtime image installs only express and cookie-parser,
 * and a single-container deployment has nowhere to share state anyway.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: RateLimitOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  check(key: string): RateLimitVerdict {
    const now = this.now();
    const existing = this.hits.get(key);

    if (!existing || existing.resetAt <= now) {
      this.evictIfFull(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (existing.count >= this.limit) {
      return { allowed: false, retryAfterMs: existing.resetAt - now };
    }

    existing.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  get trackedKeys(): number { return this.hits.size; }

  /** Drop expired windows; if still at capacity, drop the window expiring soonest. */
  private evictIfFull(now: number): void {
    if (this.hits.size < this.maxKeys) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
    if (this.hits.size < this.maxKeys) return;
    let oldestKey: string | null = null;
    let oldestResetAt = Infinity;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt < oldestResetAt) { oldestResetAt = entry.resetAt; oldestKey = key; }
    }
    if (oldestKey !== null) this.hits.delete(oldestKey);
  }
}

export function rateLimit(
  limiter: RateLimiter,
  keyOf: (req: Request) => string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = limiter.check(keyOf(req));
    if (verdict.allowed) { next(); return; }
    res.setHeader('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
    res.status(429).json({ error: 'rate_limited', retryAfterMs: verdict.retryAfterMs });
  };
}
