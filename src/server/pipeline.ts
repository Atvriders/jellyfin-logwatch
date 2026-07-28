import type { SourceState } from '../shared/types.js';
import type { EntryBuffer } from './entryBuffer.js';
import type { LineParser } from './logParser.js';
import type { LogFileWatcher } from './logWatcher.js';
import type { SseHub } from './sseHub.js';
import type { StatsEngine } from './statsEngine.js';

export interface PipelineDeps {
  watcher: LogFileWatcher;
  parser: LineParser;
  buffer: EntryBuffer;
  stats: StatsEngine;
  hub: SseHub;
  statsIntervalMs?: number;
}

export class Pipeline {
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  async start(): Promise<void> {
    const { watcher, parser, stats, hub } = this.deps;

    // Listeners are attached before start() so the watcher's very first
    // rescan/poll (waiting state + startup tail) is not lost.
    watcher.on('lines', (lines: string[]) => { this.emit(parser.write(lines)); });
    watcher.on('idle', () => { this.emit(parser.flush()); });
    watcher.on('rotate', (file: string) => {
      this.emit(parser.flush());
      hub.publish('rotate', { file });
    });
    watcher.on('waiting', (waiting: boolean) => { hub.publish('waiting', { waiting }); });
    watcher.on('error', (error: Error) => { console.error('[logwatch] watcher error:', error.message); });

    await watcher.start();

    const interval = this.deps.statsIntervalMs ?? 1000;
    this.statsTimer = setInterval(() => { hub.publishStats(stats.snapshot()); }, interval);
    this.statsTimer.unref?.();
  }

  stop(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.deps.watcher.stop();
  }

  source(): SourceState {
    return { file: this.deps.watcher.activeFile, waiting: this.deps.watcher.waiting };
  }

  private emit(parsed: ReturnType<LineParser['write']>): void {
    if (parsed.length === 0) return;
    const stored = this.deps.buffer.addAll(parsed);
    for (const entry of stored) this.deps.stats.record(entry);
    this.deps.hub.publishEntries(stored);
  }
}
