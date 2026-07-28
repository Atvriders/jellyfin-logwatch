import { Router, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import { JellyfinAuthError, JellyfinUnreachableError, type JellyfinClient } from '../jellyfinClient.js';
import { RateLimiter, rateLimit } from '../rateLimit.js';
import {
  LockoutTracker, clearSession, clientIp, readSession, writeSession,
} from '../sessionAuth.js';

export function authRoutes(deps: {
  config: Config;
  jellyfin: JellyfinClient;
  lockout: LockoutTracker;
  loginLimiter?: RateLimiter;
}): Router {
  const router = Router();
  const { config, jellyfin, lockout } = deps;

  // /login is the only unauthenticated endpoint that reaches Jellyfin, and the
  // limiter and the lockout do different jobs. LockoutTracker counts *failed
  // password* attempts only, so requests that never get that far — malformed
  // bodies, or a Jellyfin that is down — are unbounded without this. Keep both.
  const loginLimiter = deps.loginLimiter ?? new RateLimiter({ limit: 30, windowMs: 60_000 });
  const limitLogin = rateLimit(loginLimiter, (req) => clientIp(req, config.trustProxy));

  router.get('/session', (req: Request, res: Response) => {
    const session = readSession(req);
    res.json({ authenticated: Boolean(session), username: session?.username ?? null });
  });

  router.post('/login', limitLogin, async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: 'missing_credentials' });
      return;
    }
    const ip = clientIp(req, config.trustProxy);
    if (lockout.isBlocked(ip)) {
      res.status(429).json({ error: 'locked_out', retryAfterMs: lockout.retryAfterMs(ip) });
      return;
    }
    try {
      const result = await jellyfin.authenticate(username, password);
      await jellyfin.revoke(result.token);
      lockout.reset(ip);
      writeSession(res, req, { username: result.name, userId: result.userId, issuedAt: Date.now() });
      res.json({ authenticated: true, username: result.name });
    } catch (error) {
      if (error instanceof JellyfinUnreachableError) {
        res.status(503).json({ error: 'jellyfin_unreachable' });
        return;
      }
      // One response for "no such user" and "wrong password" alike. Jellyfin
      // returns 401 for both, so there is nothing here to tell them apart —
      // keep it that way. Never branch on the username: the typed-username
      // login exists precisely so the account list stays unenumerable.
      if (error instanceof JellyfinAuthError) {
        lockout.recordFailure(ip);
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      res.status(500).json({ error: 'login_failed' });
    }
  });

  router.post('/logout', (_req: Request, res: Response) => {
    clearSession(res);
    res.json({ authenticated: false, username: null });
  });

  return router;
}
