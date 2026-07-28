import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import { StatsEngine } from '../../src/server/statsEngine.js';
import { SseHub } from '../../src/server/sseHub.js';
import {
  JellyfinClient, JellyfinAuthError, JellyfinUnreachableError,
} from '../../src/server/jellyfinClient.js';
import { LockoutTracker } from '../../src/server/sessionAuth.js';
import { RateLimiter } from '../../src/server/rateLimit.js';

const config = {
  jellyfinUrl: 'http://jf:8096', sessionSecret: 'secret',
  logDir: '/logs', port: 3000, bufferSize: 100, pollIntervalMs: 10,
  rescanIntervalMs: 10, startupTailBytes: 1024, maxTraceLines: 500, trustProxy: false,
};

const makeJellyfin = (overrides: Record<string, unknown> = {}) => ({
  authenticate: vi.fn(async () => ({ userId: '1', name: 'james', token: 'tok' })),
  revoke: vi.fn(async () => undefined),
  ...overrides,
});

/**
 * A REAL JellyfinClient over a fetch that knows exactly one account, answering
 * 401 to everything else — which is what a real Jellyfin does for an unknown
 * username and for a wrong password alike. Used by the enumeration test, so
 * the identical responses it asserts are a property of our handler rather than
 * of a stub that fails every call the same way.
 */
const oneAccountJellyfin = () => new JellyfinClient({
  baseUrl: 'http://jf:8096',
  fetchImpl: (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith('/Users/AuthenticateByName')) return new Response('', { status: 204 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { Username?: string; Pw?: string };
    if (body.Username === 'james' && body.Pw === 'correct-horse') {
      return new Response(
        JSON.stringify({ AccessToken: 'tok', User: { Id: '1', Name: 'james' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('', { status: 401 });
  }) as unknown as typeof fetch,
});

let buffer: EntryBuffer;
let hub: SseHub;
const build = (
  jellyfin: object = makeJellyfin(),
  lockout = new LockoutTracker(),
  loginLimiter?: RateLimiter,
  configOverrides: Partial<typeof config> = {},
) => {
  buffer = new EntryBuffer(100);
  hub = new SseHub({ flushIntervalMs: 0, heartbeatMs: 0 });
  return createApp({
    config: { ...config, ...configOverrides } as never,
    jellyfin: jellyfin as never,
    buffer,
    stats: new StatsEngine(),
    hub,
    pipeline: { source: () => ({ file: 'log_a.log', waiting: false }) },
    lockout,
    loginLimiter,
    clientDir: null,
  });
};

const login = async (app: ReturnType<typeof build>) => {
  const res = await request(app).post('/api/login').send({ username: 'james', password: 'pw' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'] as unknown as string[];
};

beforeEach(() => { hub?.close(); });

describe('routes', () => {
  it('serves health without auth', async () => {
    const res = await request(build()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('reports an unauthenticated session', async () => {
    const res = await request(build()).get('/api/session');
    expect(res.body).toEqual({ authenticated: false, username: null });
  });

  it('rejects the snapshot and stream without a session', async () => {
    const app = build();
    expect((await request(app).get('/api/snapshot')).status).toBe(401);
    expect((await request(app).get('/api/stream')).status).toBe(401);
  });

  it('logs in, revokes the Jellyfin token, and exposes the session', async () => {
    const jellyfin = makeJellyfin();
    const app = build(jellyfin);
    const cookie = await login(app);
    expect(jellyfin.revoke).toHaveBeenCalledWith('tok');
    const res = await request(app).get('/api/session').set('Cookie', cookie);
    expect(res.body).toEqual({ authenticated: true, username: 'james' });
  });

  it('returns 401 with a wrong-password code', async () => {
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinAuthError('nope'); }),
    });
    const res = await request(build(jellyfin)).post('/api/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('returns 503 when Jellyfin is unreachable and consumes no lockout attempt', async () => {
    const lockout = new LockoutTracker();
    const spy = vi.spyOn(lockout, 'recordFailure');
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinUnreachableError('down'); }),
    });
    const res = await request(build(jellyfin, lockout)).post('/api/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'jellyfin_unreachable' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 429 once the lockout threshold is reached', async () => {
    const lockout = new LockoutTracker({ maxAttempts: 2 });
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinAuthError('nope'); }),
    });
    const app = build(jellyfin, lockout);
    await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    const res = await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('locked_out');
  });

  it('rejects a login with a missing field', async () => {
    const res = await request(build()).post('/api/login').send({ username: 'a' });
    expect(res.status).toBe(400);
  });

  it('returns the snapshot with entries, stats and source once authenticated', async () => {
    const app = build();
    const cookie = await login(app);
    buffer.add({ ts: null, level: 'error', thread: null, component: 'A.B', message: 'boom', trace: ['x'], traceTruncated: false });
    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ seq: 1, level: 'error', message: 'boom' });
    expect(res.body.source).toEqual({ file: 'log_a.log', waiting: false });
    expect(res.body.lastSeq).toBe(1);
    expect(res.body.stats.windowMinutes).toBe(15);
  });

  it('honours the snapshot limit parameter', async () => {
    const app = build();
    const cookie = await login(app);
    for (let i = 0; i < 5; i++) {
      buffer.add({ ts: null, level: 'info', thread: null, component: 'A', message: `m${i}`, trace: [], traceTruncated: false });
    }
    const res = await request(app).get('/api/snapshot?limit=2').set('Cookie', cookie);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[1].message).toBe('m4');
  });

  it('logs out and invalidates the cookie', async () => {
    const app = build();
    const cookie = await login(app);
    await request(app).post('/api/logout').set('Cookie', cookie).expect(200);
    const stale = await request(app).get('/api/session');
    expect(stale.body.authenticated).toBe(false);
  });

  // ---------------------------------------------------------------------
  // The account list is gone. These are the properties the change exists for.
  // ---------------------------------------------------------------------

  it('has no user directory: GET /api/users is 404, not an authenticated route', async () => {
    const app = build();
    // 404 unauthenticated, and still 404 while signed in — the endpoint does
    // not exist, rather than existing behind a session that any account has.
    expect((await request(app).get('/api/users')).status).toBe(404);
    const cookie = await login(app);
    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(404);
  });

  it('has no avatar proxy: GET /api/users/1/avatar is 404', async () => {
    const app = build();
    expect((await request(app).get('/api/users/1/avatar')).status).toBe(404);
    const cookie = await login(app);
    expect((await request(app).get('/api/users/1/avatar').set('Cookie', cookie)).status).toBe(404);
  });

  it('answers an unknown username and a wrong password byte for byte identically', async () => {
    const app = build(oneAccountJellyfin());

    const unknownUser = await request(app).post('/api/login')
      .send({ username: 'nobody-here', password: 'correct-horse' });
    const wrongPassword = await request(app).post('/api/login')
      .send({ username: 'james', password: 'wrong' });

    // Same status, same bytes, same shape of response: nothing distinguishes
    // "that account does not exist" from "that password is wrong", so the port
    // cannot be used to discover who has an account on this server.
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.status).toBe(unknownUser.status);
    expect(unknownUser.text).toBe('{"error":"invalid_credentials"}');
    expect(wrongPassword.text).toBe(unknownUser.text);
    expect(wrongPassword.headers['content-type']).toBe(unknownUser.headers['content-type']);
    expect(wrongPassword.headers['content-length']).toBe(unknownUser.headers['content-length']);
    expect(unknownUser.headers['set-cookie']).toBeUndefined();
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    // Neither response echoes back what was typed.
    expect(unknownUser.text).not.toContain('nobody-here');
    expect(wrongPassword.text).not.toContain('james');

    // …and the fixture really does tell the two apart, so the equality above
    // is our handler's doing and not a stub that rejects everything.
    const good = await request(app).post('/api/login')
      .send({ username: 'james', password: 'correct-horse' });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ authenticated: true, username: 'james' });
  });

  it('rate limits POST /login with the injected limiter', async () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinAuthError('nope'); }),
    });
    const app = build(jellyfin, new LockoutTracker(), limiter);
    const attempt = () => request(app).post('/api/login').send({ username: 'a', password: 'b' });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    // A different cap from the lockout, and it says so.
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
    // The blocked request never reached Jellyfin.
    expect(jellyfin.authenticate).toHaveBeenCalledTimes(2);
  });

  it('bounds the login requests the lockout never counts', async () => {
    // LockoutTracker counts failed *passwords*. Malformed bodies never get
    // that far, so without the limiter in front of /login they are unbounded.
    const lockout = new LockoutTracker();
    const spy = vi.spyOn(lockout, 'recordFailure');
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
    const app = build(makeJellyfin(), lockout, limiter);

    expect((await request(app).post('/api/login').send({ username: 'a' })).status).toBe(400);
    expect((await request(app).post('/api/login').send({})).status).toBe(400);
    const blocked = await request(app).post('/api/login').send({ username: 'a' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not rate limit an authenticated session out of the feed', async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    const app = build(makeJellyfin(), new LockoutTracker(), limiter);
    const cookie = await login(app);
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/snapshot').set('Cookie', cookie)).status).toBe(200);
    }
  });

  it('omits Secure on a plain-HTTP session cookie so LAN deploys work', async () => {
    const res = await request(build()).post('/api/login').send({ username: 'james', password: 'pw' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('sets Secure when the proxy reports an HTTPS client connection', async () => {
    const app = build(makeJellyfin(), new LockoutTracker(), undefined, { trustProxy: true });
    const res = await request(app)
      .post('/api/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ username: 'james', password: 'pw' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toContain('Secure');
  });

  it('does not set Secure behind an HTTP-only proxy, which would loop the login', async () => {
    const app = build(makeJellyfin(), new LockoutTracker(), undefined, { trustProxy: true });
    const res = await request(app)
      .post('/api/login')
      .set('X-Forwarded-Proto', 'http')
      .send({ username: 'james', password: 'pw' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).not.toContain('Secure');
  });

});
