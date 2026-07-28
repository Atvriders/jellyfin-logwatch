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
  publicLimiter?: RateLimiter;
}): Router {
  const router = Router();
  const { config, jellyfin, lockout } = deps;

  // /users and /users/:id/avatar must be reachable before anyone is signed in —
  // the login screen cannot render otherwise — so they are unauthenticated
  // proxies to Jellyfin. Rate limit them: unthrottled they let anyone enumerate
  // every enabled username for free, and let anyone drive traffic at Jellyfin.
  const publicLimiter = deps.publicLimiter ?? new RateLimiter({ limit: 30, windowMs: 60_000 });
  const limitPublic = rateLimit(publicLimiter, (req) => clientIp(req, config.trustProxy));

  router.get('/session', (req: Request, res: Response) => {
    const session = readSession(req);
    res.json({ authenticated: Boolean(session), username: session?.username ?? null });
  });

  router.get('/users', limitPublic, async (_req: Request, res: Response) => {
    try {
      res.json(await jellyfin.listUsers());
    } catch {
      res.status(503).json({ error: 'jellyfin_unreachable' });
    }
  });

  // Request<{ id: string }>: express 5's default ParamsDictionary types every
  // param as `string | string[]`, which fetchAvatar(userId: string) rejects.
  router.get('/users/:id/avatar', limitPublic, async (req: Request<{ id: string }>, res: Response) => {
    const avatar = await jellyfin.fetchAvatar(req.params.id).catch(() => null);
    if (!avatar) { res.status(404).end(); return; }
    res.setHeader('Content-Type', avatar.contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(avatar.body);
  });

  router.post('/login', async (req: Request, res: Response) => {
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
