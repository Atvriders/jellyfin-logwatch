import type { Level, LogEntry } from '../shared/types.js';

export type ParsedEntry = Omit<LogEntry, 'seq'>;

const PRIMARY =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}(?:\s?[+-]\d{2}:\d{2})?)\] \[([A-Za-z]{3})\] \[(\d+)\] (.+?): ([\s\S]*)$/;

const SECONDARY =
  /^\[(\d{2}:\d{2}:\d{2})\] \[([A-Za-z]{3})\] \[([^\]]+)\] ([\s\S]*)$/;

const LEVEL_BY_CODE: Record<string, Level> = {
  VRB: 'verbose', DBG: 'debug', INF: 'info',
  WRN: 'warn', ERR: 'error', FTL: 'fatal',
};

function toLevel(code: string): Level {
  return LEVEL_BY_CODE[code.toUpperCase()] ?? 'raw';
}

function toIso(value: string): string | null {
  const normalized = value.replace(' ', 'T').replace(/T(\d{2}:\d{2}:\d{2}\.\d{3})\s?/, 'T$1');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface Open {
  entry: ParsedEntry;
  dropped: number;
}

export interface LineParserOptions {
  maxTraceLines: number;
  fallbackDate: () => string;
}

export class LineParser {
  private open: Open | null = null;

  constructor(private readonly opts: LineParserOptions) {}

  write(lines: string[]): ParsedEntry[] {
    const completed: ParsedEntry[] = [];
    for (const line of lines) {
      const started = this.startEntry(line);
      if (started) {
        const previous = this.close();
        if (previous) completed.push(previous);
        this.open = { entry: started, dropped: 0 };
      } else if (this.open) {
        this.appendTrace(this.open, line);
      } else {
        completed.push(this.rawEntry(line));
      }
    }
    return completed;
  }

  flush(): ParsedEntry[] {
    const entry = this.close();
    return entry ? [entry] : [];
  }

  private close(): ParsedEntry | null {
    if (!this.open) return null;
    const { entry, dropped } = this.open;
    if (dropped > 0) {
      entry.trace.push(`… ${dropped} more lines truncated`);
      entry.traceTruncated = true;
    }
    this.open = null;
    return entry;
  }

  private appendTrace(open: Open, line: string): void {
    if (open.entry.trace.length < this.opts.maxTraceLines) {
      open.entry.trace.push(line);
    } else {
      open.dropped += 1;
    }
  }

  private rawEntry(line: string): ParsedEntry {
    return {
      ts: null, level: 'raw', thread: null, component: null,
      message: line, trace: [], traceTruncated: false,
    };
  }

  private startEntry(line: string): ParsedEntry | null {
    const primary = PRIMARY.exec(line);
    if (primary) {
      return {
        ts: toIso(primary[1]!),
        level: toLevel(primary[2]!),
        thread: Number(primary[3]),
        component: primary[4]!,
        message: primary[5]!,
        trace: [], traceTruncated: false,
      };
    }
    const secondary = SECONDARY.exec(line);
    if (secondary) {
      return {
        // The date-less console template carries no offset. Anchor it to UTC so the
        // resulting ISO date always equals the fallback date, whatever TZ the host runs in.
        ts: toIso(`${this.opts.fallbackDate()} ${secondary[1]!}.000Z`),
        level: toLevel(secondary[2]!),
        thread: null,
        component: secondary[3]!,
        message: secondary[4]!,
        trace: [], traceTruncated: false,
      };
    }
    return null;
  }
}
