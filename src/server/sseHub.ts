import type { Response } from 'express';
import type { LogEntry, Stats } from '../shared/types.js';

export interface SseHubOptions {
  flushIntervalMs?: number;
  maxBatch?: number;
  heartbeatMs?: number;
}

export class SseHub {
  private readonly clients = new Set<Response>();
  private pendingEntries: LogEntry[] = [];
  private pendingStats: Stats | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly maxBatch: number;

  constructor(opts: SseHubOptions = {}) {
    this.maxBatch = opts.maxBatch ?? 500;
    const flushIntervalMs = opts.flushIntervalMs ?? 100;
    const heartbeatMs = opts.heartbeatMs ?? 20_000;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
      this.flushTimer.unref?.();
    }
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.writeAll(': heartbeat\n\n'), heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  addClient(res: Response): () => void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    this.clients.add(res);
    const detach = () => { this.clients.delete(res); };
    res.on('close', detach);
    return detach;
  }

  publishEntries(entries: LogEntry[]): void {
    if (entries.length > 0) this.pendingEntries.push(...entries);
  }

  publishStats(stats: Stats): void { this.pendingStats = stats; }

  publish(event: 'rotate' | 'waiting' | 'resnapshot', data: unknown): void {
    this.writeAll(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  flush(): void {
    if (this.pendingEntries.length > 0) {
      const batch = this.pendingEntries.length > this.maxBatch
        ? this.pendingEntries.slice(this.pendingEntries.length - this.maxBatch)
        : this.pendingEntries;
      this.pendingEntries = [];
      const lastSeq = batch[batch.length - 1]!.seq;
      this.writeAll(`event: entries\nid: ${lastSeq}\ndata: ${JSON.stringify(batch)}\n\n`);
    }
    if (this.pendingStats) {
      this.writeAll(`event: stats\ndata: ${JSON.stringify(this.pendingStats)}\n\n`);
      this.pendingStats = null;
    }
  }

  get clientCount(): number { return this.clients.size; }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    for (const client of this.clients) { try { client.end(); } catch { /* already gone */ } }
    this.clients.clear();
  }

  private writeAll(payload: string): void {
    for (const client of [...this.clients]) {
      try {
        client.write(payload);
      } catch {
        // A dead socket (EPIPE / ERR_STREAM_WRITE_AFTER_END) must not stall the hub.
        this.clients.delete(client);
      }
    }
  }
}
