import { describe, it, expect } from 'vitest';
import { StatsEngine } from '../../src/server/statsEngine.js';
import type { LogEntry, Level } from '../../src/shared/types.js';

let seq = 0;
const entry = (level: Level, component = 'A.B'): LogEntry => ({
  seq: ++seq, ts: null, level, thread: null, component,
  message: 'm', trace: [], traceTruncated: false,
});

describe('StatsEngine', () => {
  it('counts by level inside the window', () => {
    let now = 1_000_000;
    const stats = new StatsEngine({ now: () => now });
    stats.record(entry('error'));
    stats.record(entry('error'));
    stats.record(entry('info'));
    const snap = stats.snapshot();
    expect(snap.counts.error).toBe(2);
    expect(snap.counts.info).toBe(1);
    expect(snap.counts.fatal).toBe(0);
    expect(snap.windowMinutes).toBe(15);
  });

  it('drops entries older than the window', () => {
    let now = 1_000_000;
    const stats = new StatsEngine({ now: () => now });
    stats.record(entry('error'));
    now += 16 * 60_000;
    expect(stats.snapshot().counts.error).toBe(0);
  });

  it('returns exactly windowMinutes sparkline buckets, oldest first', () => {
    let now = 1_000_000;
    const stats = new StatsEngine({ now: () => now });
    stats.record(entry('info'));
    now += 60_000;
    stats.record(entry('info'));
    stats.record(entry('info'));
    const snap = stats.snapshot();
    expect(snap.sparkline).toHaveLength(15);
    expect(snap.sparkline[14]).toBe(2);
    expect(snap.sparkline[13]).toBe(1);
    expect(snap.sparkline.slice(0, 13).every((n) => n === 0)).toBe(true);
  });

  it('ranks the top five components and ignores null components', () => {
    let now = 1_000_000;
    const stats = new StatsEngine({ now: () => now });
    for (const name of ['a', 'a', 'a', 'b', 'b', 'c', 'd', 'e', 'f']) {
      stats.record(entry('info', name));
    }
    const nullComponent = { ...entry('raw'), component: null };
    stats.record(nullComponent);
    const top = stats.snapshot().topComponents;
    expect(top).toHaveLength(5);
    expect(top[0]).toEqual({ component: 'a', count: 3 });
    expect(top[1]).toEqual({ component: 'b', count: 2 });
    expect(top.map((t) => t.component)).not.toContain(null);
  });

  it('reports lines per second over the last full minute bucket', () => {
    let now = 1_000_000;
    const stats = new StatsEngine({ now: () => now });
    for (let i = 0; i < 120; i++) stats.record(entry('info'));
    expect(stats.snapshot().linesPerSecond).toBe(2);
  });

  it('reports zero rate and empty ranks with no data', () => {
    const stats = new StatsEngine({ now: () => 1_000_000 });
    const snap = stats.snapshot();
    expect(snap.linesPerSecond).toBe(0);
    expect(snap.topComponents).toEqual([]);
    expect(snap.sparkline).toEqual(Array(15).fill(0));
  });
});
