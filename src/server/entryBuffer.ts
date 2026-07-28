import type { LogEntry } from '../shared/types.js';
import type { ParsedEntry } from './logParser.js';

export class EntryBuffer {
  private readonly entries: LogEntry[] = [];
  private seq = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('EntryBuffer capacity must be a positive integer');
    }
  }

  add(entry: ParsedEntry): LogEntry {
    const stored: LogEntry = { ...entry, seq: ++this.seq };
    this.entries.push(stored);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return stored;
  }

  addAll(entries: ParsedEntry[]): LogEntry[] {
    return entries.map((entry) => this.add(entry));
  }

  snapshot(limit?: number): LogEntry[] {
    if (limit === undefined || limit >= this.entries.length) return [...this.entries];
    return this.entries.slice(this.entries.length - limit);
  }

  since(seq: number): LogEntry[] | null {
    // seq <= 0 means "I have nothing yet" — always replayable with whatever is retained.
    if (seq <= 0) return [...this.entries];
    // A client ahead of us (e.g. the server restarted and seq reset) must resnapshot,
    // otherwise it would silently skip every entry until seq catches back up.
    if (seq > this.seq) return null;
    const oldest = this.entries[0];
    // The client's last seen entry has been evicted: we cannot prove nothing was missed.
    if (oldest && seq < oldest.seq) return null;
    return this.entries.filter((entry) => entry.seq > seq);
  }

  get lastSeq(): number { return this.seq; }
  get size(): number { return this.entries.length; }
}
