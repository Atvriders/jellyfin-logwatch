import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'logwatch_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  username: string;
  userId: string;
  issuedAt: number;
}

export interface LockoutOptions {
  maxAttempts?: number;
  windowMs?: number;
  blockMs?: number;
  now?: () => number;
}

export class LockoutTracker {
  private readonly failures = new Map<string, number[]>();
  private readonly blocked = new Map<string, number>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(opts: LockoutOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.windowMs = opts.windowMs ?? 300_000;
    this.blockMs = opts.blockMs ?? 900_000;
    this.now = opts.now ?? (() => Date.now());
  }

  isBlocked(ip: string): boolean { return this.retryAfterMs(ip) > 0; }

  retryAfterMs(ip: string): number {
    const until = this.blocked.get(ip);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.blocked.delete(ip);
      this.failures.delete(ip);
      return 0;
    }
    return remaining;
  }

  recordFailure(ip: string): void {
    const now = this.now();
    const recent = (this.failures.get(ip) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    this.failures.set(ip, recent);
    if (recent.length >= this.maxAttempts) {
      this.blocked.set(ip, now + this.blockMs);
    }
    this.prune(now);
  }

  /**
   * Both maps are keyed by client IP, and with TRUST_PROXY=1 that key comes from
   * an attacker-controlled header — so without pruning a spray of forged
   * X-Forwarded-For values grows them without bound. Entries that can no longer
   * affect a decision are dropped on every failure.
   */
  private prune(now: number): void {
    for (const [ip, until] of this.blocked) {
      if (until <= now) { this.blocked.delete(ip); this.failures.delete(ip); }
    }
    for (const [ip, attempts] of this.failures) {
      if (this.blocked.has(ip)) continue;
      if (attempts.every((at) => now - at >= this.windowMs)) this.failures.delete(ip);
    }
  }

  reset(ip: string): void {
    this.failures.delete(ip);
    this.blocked.delete(ip);
  }
}

export function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header.join(',') : header;
    const tokens = (raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const rightmost = tokens[tokens.length - 1];
    if (rightmost) return rightmost;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function readSession(req: Request): SessionPayload | null {
  const raw = req.signedCookies?.[SESSION_COOKIE];
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as SessionPayload;
    if (typeof parsed.username !== 'string' || typeof parsed.userId !== 'string') return null;
    // Validate issuedAt before comparing: `Date.now() - undefined` is NaN, and
    // `NaN > MAX_AGE_MS` is false, so an absent or non-numeric issuedAt would
    // make the expiry check silently pass. Fail closed instead.
    if (!Number.isFinite(parsed.issuedAt)) return null;
    if (Date.now() - parsed.issuedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * `secure` is derived from the actual request scheme, never from TRUST_PROXY.
 * Tying it to TRUST_PROXY fails both ways: served over HTTPS without the flag
 * the cookie loses `Secure` entirely, and set behind an HTTP-only proxy the
 * browser would never send the cookie back, silently looping the login.
 * `req.secure` honours X-Forwarded-Proto once `trust proxy` is enabled (app.ts
 * does that when TRUST_PROXY=1), so plain-HTTP LAN deployments still work.
 */
export function writeSession(res: Response, req: Request, payload: SessionPayload): void {
  res.cookie(SESSION_COOKIE, JSON.stringify(payload), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    signed: true,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (readSession(req)) { next(); return; }
  res.status(401).json({ error: 'unauthorized' });
}
