import { describe, it, expect, vi } from 'vitest';
import { SseHub } from '../../src/server/sseHub.js';
import type { Response } from 'express';
import type { LogEntry } from '../../src/shared/types.js';

const fakeRes = () => {
  const chunks: string[] = [];
  const handlers = new Map<string, () => void>();
  return {
    chunks,
    res: {
      write: (chunk: string) => { chunks.push(chunk); return true; },
      end: vi.fn(),
      on: (event: string, handler: () => void) => { handlers.set(event, handler); },
      flushHeaders: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as Response,
    close: () => handlers.get('close')?.(),
  };
};

const entry = (seq: number): LogEntry => ({
  seq, ts: null, level: 'info', thread: null, component: 'A',
  message: `m${seq}`, trace: [], traceTruncated: false,
});

describe('SseHub', () => {
  it('batches entries until flush and emits a single event with the last id', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publishEntries([entry(1), entry(2)]);
    expect(client.chunks.join('')).toBe('');
    hub.flush();
    const payload = client.chunks.join('');
    expect(payload).toContain('event: entries');
    expect(payload).toContain('id: 2');
    expect(payload).toMatch(/data: .*"m1".*"m2"/);
    hub.close();
  });

  it('caps a flush at maxBatch, keeping the newest entries', () => {
    const hub = new SseHub({ flushIntervalMs: 0, maxBatch: 2 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publishEntries([entry(1), entry(2), entry(3)]);
    hub.flush();
    const payload = client.chunks.join('');
    expect(payload).toContain('"m3"');
    expect(payload).not.toContain('"m1"');
    expect(payload).toContain('id: 3');
    hub.close();
  });

  it('coalesces stats so only the latest is sent per flush', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publishStats({ windowMinutes: 15, counts: {} as never, sparkline: [1], topComponents: [], linesPerSecond: 1 });
    hub.publishStats({ windowMinutes: 15, counts: {} as never, sparkline: [2], topComponents: [], linesPerSecond: 2 });
    hub.flush();
    const payload = client.chunks.join('');
    expect(payload.match(/event: stats/g)).toHaveLength(1);
    expect(payload).toContain('"linesPerSecond":2');
    hub.close();
  });

  it('sends rotate and waiting immediately without a flush', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publish('rotate', { file: 'log_x.log' });
    expect(client.chunks.join('')).toContain('event: rotate');
    hub.close();
  });

  it('drops a client on close and stops writing to it', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    expect(hub.clientCount).toBe(1);
    client.close();
    expect(hub.clientCount).toBe(0);
    client.chunks.length = 0;
    hub.publishEntries([entry(1)]);
    hub.flush();
    expect(client.chunks.join('')).toBe('');
    hub.close();
  });

  it('removes a client whose write throws', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const res = {
      write: () => { throw new Error('EPIPE'); },
      end: vi.fn(), on: vi.fn(), flushHeaders: vi.fn(), setHeader: vi.fn(),
    } as unknown as Response;
    hub.addClient(res);
    hub.publishEntries([entry(1)]);
    hub.flush();
    expect(hub.clientCount).toBe(0);
    hub.close();
  });
});
