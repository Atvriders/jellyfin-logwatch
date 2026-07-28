import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogFileWatcher } from '../../src/server/logWatcher.js';

let dir = '';
const opts = () => ({ dir, pollIntervalMs: 10, rescanIntervalMs: 10, startupTailBytes: 1024 });

const collect = (watcher: LogFileWatcher) => {
  const lines: string[] = [];
  const events: string[] = [];
  watcher.on('lines', (l: string[]) => lines.push(...l));
  watcher.on('idle', () => events.push('idle'));
  watcher.on('rotate', (f: string) => events.push(`rotate:${f}`));
  watcher.on('waiting', (w: boolean) => events.push(`waiting:${w}`));
  return { lines, events };
};

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'logwatch-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('LogFileWatcher', () => {
  it('selects the newest log_*.log and tails it from the end on start', async () => {
    await writeFile(join(dir, 'log_20260725.log'), 'old\n');
    await utimes(join(dir, 'log_20260725.log'), new Date(1000), new Date(1000));
    await writeFile(join(dir, 'log_20260726.log'), 'first\nsecond\n');
    const watcher = new LogFileWatcher(opts());
    const { lines } = collect(watcher);
    await watcher.start();
    expect(watcher.activeFile).toBe('log_20260726.log');
    expect(lines).toEqual(['first', 'second']);
  });

  it('emits only newly appended lines on the next poll', async () => {
    await writeFile(join(dir, 'log_a.log'), 'one\n');
    const watcher = new LogFileWatcher(opts());
    const { lines } = collect(watcher);
    await watcher.start();
    await appendFile(join(dir, 'log_a.log'), 'two\nthree\n');
    await watcher.poll();
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('holds a trailing partial line until it is completed', async () => {
    await writeFile(join(dir, 'log_a.log'), '');
    const watcher = new LogFileWatcher(opts());
    const { lines } = collect(watcher);
    await watcher.start();
    await appendFile(join(dir, 'log_a.log'), 'par');
    await watcher.poll();
    expect(lines).toEqual([]);
    await appendFile(join(dir, 'log_a.log'), 'tial\n');
    await watcher.poll();
    expect(lines).toEqual(['partial']);
  });

  it('emits idle when a poll finds no growth', async () => {
    await writeFile(join(dir, 'log_a.log'), 'x\n');
    const watcher = new LogFileWatcher(opts());
    const { events } = collect(watcher);
    await watcher.start();
    await watcher.poll();
    expect(events).toContain('idle');
  });

  it('re-reads from zero when the file is truncated', async () => {
    await writeFile(join(dir, 'log_a.log'), 'aaaa\nbbbb\n');
    const watcher = new LogFileWatcher(opts());
    const { lines } = collect(watcher);
    await watcher.start();
    lines.length = 0;
    await writeFile(join(dir, 'log_a.log'), 'c\n');
    await watcher.poll();
    expect(lines).toEqual(['c']);
  });

  it('switches to a newer file and emits rotate', async () => {
    await writeFile(join(dir, 'log_20260726.log'), 'today\n');
    const watcher = new LogFileWatcher(opts());
    const { lines, events } = collect(watcher);
    await watcher.start();
    lines.length = 0;
    await writeFile(join(dir, 'log_20260727.log'), 'tomorrow\n');
    await utimes(join(dir, 'log_20260727.log'), new Date(), new Date(Date.now() + 60_000));
    await watcher.rescan();
    await watcher.poll();
    expect(events).toContain('rotate:log_20260727.log');
    expect(watcher.activeFile).toBe('log_20260727.log');
    expect(lines).toEqual(['tomorrow']);
  });

  it('reports waiting when the directory holds no log files, then recovers', async () => {
    const watcher = new LogFileWatcher(opts());
    const { events, lines } = collect(watcher);
    await watcher.start();
    expect(watcher.waiting).toBe(true);
    expect(events).toContain('waiting:true');
    await writeFile(join(dir, 'log_a.log'), 'hello\n');
    await watcher.rescan();
    await watcher.poll();
    expect(watcher.waiting).toBe(false);
    expect(lines).toEqual(['hello']);
  });

  it('reports waiting when the directory does not exist at all', async () => {
    const watcher = new LogFileWatcher({ ...opts(), dir: join(dir, 'nope') });
    collect(watcher);
    await watcher.start();
    expect(watcher.waiting).toBe(true);
  });

  it('reads only the last startupTailBytes on a large file', async () => {
    const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n') + '\n';
    await writeFile(join(dir, 'log_a.log'), big);
    const watcher = new LogFileWatcher({ ...opts(), startupTailBytes: 40 });
    const { lines } = collect(watcher);
    await watcher.start();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(10);
    expect(lines[lines.length - 1]).toBe('line499');
    expect(lines[0]).not.toBe('line0');
  });
});
