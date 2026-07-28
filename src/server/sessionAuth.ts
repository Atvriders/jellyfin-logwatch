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
    if (Date.now() - parsed.issuedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSession(res: Response, payload: SessionPayload, secure: boolean): void {
  res.cookie(SESSION_COOKIE, JSON.stringify(payload), {
    httpOnly: true, sameSite: 'lax', secure, signed: true, maxAge: MAX_AGE_MS, path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (readSession(req)) { next(); return; }
  res.status(401).json({ error: 'unauthorized' });
}
