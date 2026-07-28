import { EventEmitter } from 'node:events';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface LogFileWatcherOptions {
  dir: string;
  pollIntervalMs: number;
  rescanIntervalMs: number;
  startupTailBytes: number;
}

const LOG_FILE = /^log_.*\.log$/i;

export class LogFileWatcher extends EventEmitter {
  private file: string | null = null;
  private offset = 0;
  private partial = '';
  private isWaiting = true;
  private pollTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: LogFileWatcherOptions) { super(); }

  get activeFile(): string | null { return this.file; }
  get waiting(): boolean { return this.isWaiting; }

  async start(): Promise<void> {
    // `running` stays false for the initial rescan on purpose: setWaiting() only
    // de-duplicates once the watcher is past startup, so the first state of the
    // source is always announced.
    await this.rescan();
    await this.poll();
    this.running = true;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.opts.pollIntervalMs);
    this.rescanTimer = setInterval(() => { void this.rescan(); }, this.opts.rescanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.pollTimer = null;
    this.rescanTimer = null;
  }

  async rescan(): Promise<void> {
    const newest = await this.findNewest();
    if (!newest) {
      this.setWaiting(true);
      this.file = null;
      return;
    }
    if (newest === this.file) return;
    const isRotation = this.file !== null;
    this.file = newest;
    this.offset = 0;
    this.partial = '';
    this.setWaiting(false);
    if (isRotation) {
      this.emit('rotate', newest);
    } else {
      await this.seekToTail();
    }
  }

  async poll(): Promise<void> {
    if (!this.file) return;
    const path = join(this.opts.dir, this.file);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      // The active file can vanish mid-rotation. Report it, but never let an
      // unlistened 'error' event throw and take the process down.
      this.fail(error as Error);
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) {
      this.emit('idle');
      return;
    }
    await this.read(path, this.offset, size);
  }

  private async findNewest(): Promise<string | null> {
    let names: string[];
    try {
      names = (await readdir(this.opts.dir)).filter((n) => LOG_FILE.test(n));
    } catch {
      return null;
    }
    let best: { name: string; mtimeMs: number } | null = null;
    for (const name of names) {
      try {
        const info = await stat(join(this.opts.dir, name));
        if (!info.isFile()) continue;
        if (!best || info.mtimeMs > best.mtimeMs) best = { name, mtimeMs: info.mtimeMs };
      } catch { /* file vanished between readdir and stat */ }
    }
    return best?.name ?? null;
  }

  private async seekToTail(): Promise<void> {
    if (!this.file) return;
    const path = join(this.opts.dir, this.file);
    const size = (await stat(path)).size;
    const from = Math.max(0, size - this.opts.startupTailBytes);
    await this.read(path, from, size, from > 0);
  }

  private async read(path: string, from: number, to: number, dropFirstPartial = false): Promise<void> {
    const length = to - from;
    if (length <= 0) return;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, from);
      let text = this.partial + buffer.toString('utf8');
      if (dropFirstPartial) {
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }
      const pieces = text.split('\n');
      this.partial = pieces.pop() ?? '';
      this.offset = to;
      const lines = pieces.map((line) => line.replace(/\r$/, ''));
      if (lines.length > 0) this.emit('lines', lines);
    } finally {
      await handle.close();
    }
  }

  private fail(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  private setWaiting(value: boolean): void {
    if (this.isWaiting === value && this.running) return;
    this.isWaiting = value;
    this.emit('waiting', value);
  }
}
