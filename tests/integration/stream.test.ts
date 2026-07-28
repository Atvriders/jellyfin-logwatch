import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import { LineParser } from '../../src/server/logParser.js';
import { LogFileWatcher } from '../../src/server/logWatcher.js';
import { Pipeline } from '../../src/server/pipeline.js';
import { SseHub } from '../../src/server/sseHub.js';
import { StatsEngine } from '../../src/server/statsEngine.js';

const config = {
  jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'K', sessionSecret: 'secret',
  logDir: '', port: 0, bufferSize: 100, pollIntervalMs: 10, rescanIntervalMs: 10,
  startupTailBytes: 65536, maxTraceLines: 500, trustProxy: false,
};

const jellyfin = {
  listUsers: async () => [{ id: '1', name: 'james', hasAvatar: false }],
  authenticate: async () => ({ userId: '1', name: 'james', token: 'tok' }),
  revoke: async () => undefined,
  fetchAvatar: async () => null,
};

let dir = '';
let pipeline: Pipeline;
let hub: SseHub;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'logwatch-int-')); });
afterEach(async () => { pipeline?.stop(); hub?.close(); await rm(dir, { recursive: true, force: true }); });

const build = async () => {
  const watcher = new LogFileWatcher({ dir, pollIntervalMs: 10, rescanIntervalMs: 10, startupTailBytes: 65536 });
  const parser = new LineParser({ maxTraceLines: 500, fallbackDate: () => '2026-07-26' });
  const buffer = new EntryBuffer(100);
  const stats = new StatsEngine();
  hub = new SseHub({ flushIntervalMs: 10, heartbeatMs: 0 });
  pipeline = new Pipeline({ watcher, parser, buffer, stats, hub, statsIntervalMs: 10 });
  await pipeline.start();
  const app = createApp({ config: { ...config, logDir: dir } as never, jellyfin: jellyfin as never, buffer, stats, hub, pipeline, clientDir: null });
  return { app, watcher, buffer };
};

const settle = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)); };

const authCookie = async (app: Awaited<ReturnType<typeof build>>['app']) => {
  const res = await request(app).post('/api/login').send({ username: 'james', password: 'pw' });
  return res.headers['set-cookie'] as unknown as string[];
};

describe('file → SSE integration', () => {
  it('delivers appended lines to the snapshot in order, folding traces', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '');
    const { app } = await build();
    const cookie = await authCookie(app);

    await appendFile(join(dir, 'log_20260726.log'),
      '[2026-07-26 22:14:03.123 -05:00] [ERR] [42] A.B: boom\n' +
      '   at One()\n   at Two()\n' +
      '[2026-07-26 22:14:04.000 -05:00] [INF] [7] C.D: fine\n');
    await settle();

    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ level: 'error', message: 'boom' });
    expect(res.body.entries[0].trace).toEqual(['   at One()', '   at Two()']);
    expect(res.body.entries[1]).toMatchObject({ level: 'info', message: 'fine' });
    expect(res.body.source.waiting).toBe(false);
  });

  it('flushes a trailing entry on an idle poll', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '');
    const { app } = await build();
    const cookie = await authCookie(app);
    await appendFile(join(dir, 'log_20260726.log'), '[2026-07-26 22:15:00.000 -05:00] [WRN] [1] E.F: alone\n');
    await settle();
    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].message).toBe('alone');
  });

  it('continues across a rotation to a newer file', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '[2026-07-26 23:59:59.000 -05:00] [INF] [1] A: before\n');
    const { app } = await build();
    const cookie = await authCookie(app);
    await settle();

    const next = join(dir, 'log_20260727.log');
    await writeFile(next, '[2026-07-27 00:00:01.000 -05:00] [INF] [1] A: after\n');
    await utimes(next, new Date(), new Date(Date.now() + 60_000));
    await settle(200);

    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    const messages = res.body.entries.map((e: { message: string }) => e.message);
    expect(messages).toContain('before');
    expect(messages).toContain('after');
  });

  it('streams entries over SSE to a connected client', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '');
    const { app } = await build();
    const cookie = await authCookie(app);

    const received: string[] = [];
    const req = request(app).get('/api/stream').set('Cookie', cookie).buffer(false);
    req.on('response', (res) => { res.on('data', (chunk: Buffer) => received.push(chunk.toString())); });
    void req.end(() => undefined);
    await settle();

    await appendFile(join(dir, 'log_20260726.log'), '[2026-07-26 22:20:00.000 -05:00] [ERR] [1] Z: streamed\n');
    await settle(200);

    const payload = received.join('');
    expect(payload).toContain('event: entries');
    expect(payload).toContain('streamed');
  });

  it('reports waiting when the directory has no log files', async () => {
    const { app } = await build();
    const cookie = await authCookie(app);
    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.body.source).toEqual({ file: null, waiting: true });
  });
});
