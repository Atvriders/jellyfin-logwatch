import { LEVELS, type Level, type LogEntry, type Stats } from '../shared/types.js';

interface Bucket {
  minute: number;
  total: number;
  levels: Map<Level, number>;
  components: Map<string, number>;
}

export interface StatsEngineOptions {
  windowMinutes?: number;
  now?: () => number;
}

export class StatsEngine {
  private readonly buckets = new Map<number, Bucket>();
  private readonly windowMinutes: number;
  private readonly now: () => number;

  constructor(opts: StatsEngineOptions = {}) {
    this.windowMinutes = opts.windowMinutes ?? 15;
    this.now = opts.now ?? (() => Date.now());
  }

  record(entry: LogEntry): void {
    const minute = Math.floor(this.now() / 60_000);
    let bucket = this.buckets.get(minute);
    if (!bucket) {
      bucket = { minute, total: 0, levels: new Map(), components: new Map() };
      this.buckets.set(minute, bucket);
    }
    bucket.total += 1;
    bucket.levels.set(entry.level, (bucket.levels.get(entry.level) ?? 0) + 1);
    if (entry.component) {
      bucket.components.set(entry.component, (bucket.components.get(entry.component) ?? 0) + 1);
    }
    this.expire(minute);
  }

  snapshot(): Stats {
    const current = Math.floor(this.now() / 60_000);
    this.expire(current);

    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
    const components = new Map<string, number>();
    const sparkline: number[] = [];

    for (let i = this.windowMinutes - 1; i >= 0; i--) {
      const bucket = this.buckets.get(current - i);
      sparkline.push(bucket?.total ?? 0);
      if (!bucket) continue;
      for (const [level, count] of bucket.levels) counts[level] += count;
      for (const [name, count] of bucket.components) {
        components.set(name, (components.get(name) ?? 0) + count);
      }
    }

    const topComponents = [...components.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([component, count]) => ({ component, count }));

    return {
      windowMinutes: this.windowMinutes,
      counts,
      sparkline,
      topComponents,
      linesPerSecond: Math.round(((this.buckets.get(current)?.total ?? 0) / 60) * 100) / 100,
    };
  }

  private expire(current: number): void {
    for (const minute of this.buckets.keys()) {
      if (minute <= current - this.windowMinutes) this.buckets.delete(minute);
    }
  }
}
