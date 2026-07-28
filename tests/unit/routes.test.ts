import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import { StatsEngine } from '../../src/server/statsEngine.js';
import { SseHub } from '../../src/server/sseHub.js';
import { JellyfinAuthError, JellyfinUnreachableError } from '../../src/server/jellyfinClient.js';
import { LockoutTracker } from '../../src/server/sessionAuth.js';

const config = {
  jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'K', sessionSecret: 'secret',
  logDir: '/logs', port: 3000, bufferSize: 100, pollIntervalMs: 10,
  rescanIntervalMs: 10, startupTailBytes: 1024, maxTraceLines: 500, trustProxy: false,
};

const makeJellyfin = (overrides: Record<string, unknown> = {}) => ({
  listUsers: vi.fn(async () => [{ id: '1', name: 'james', hasAvatar: true }]),
  authenticate: vi.fn(async () => ({ userId: '1', name: 'james', token: 'tok' })),
  revoke: vi.fn(async () => undefined),
  fetchAvatar: vi.fn(async () => ({ body: Buffer.from([1]), contentType: 'image/png' })),
  ...overrides,
});

let buffer: EntryBuffer;
let hub: SseHub;
const build = (jellyfin = makeJellyfin(), lockout = new LockoutTracker()) => {
  buffer = new EntryBuffer(100);
  hub = new SseHub({ flushIntervalMs: 0, heartbeatMs: 0 });
  return createApp({
    config: config as never,
    jellyfin: jellyfin as never,
    buffer,
    stats: new StatsEngine(),
    hub,
    pipeline: { source: () => ({ file: 'log_a.log', waiting: false }) },
    lockout,
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

  it('lists users without auth', async () => {
    const res = await request(build()).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: '1', name: 'james', hasAvatar: true }]);
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

  it('returns 404 for a missing avatar', async () => {
    const jellyfin = makeJellyfin({ fetchAvatar: vi.fn(async () => null) });
    const res = await request(build(jellyfin)).get('/api/users/1/avatar');
    expect(res.status).toBe(404);
  });
});
