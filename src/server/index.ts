import { ConfigError, loadConfig } from './config.js';
import { EntryBuffer } from './entryBuffer.js';
import { JellyfinClient } from './jellyfinClient.js';
import { LineParser } from './logParser.js';
import { LogFileWatcher } from './logWatcher.js';
import { Pipeline } from './pipeline.js';
import { SseHub } from './sseHub.js';
import { StatsEngine } from './statsEngine.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const watcher = new LogFileWatcher({
    dir: config.logDir,
    pollIntervalMs: config.pollIntervalMs,
    rescanIntervalMs: config.rescanIntervalMs,
    startupTailBytes: config.startupTailBytes,
  });
  const parser = new LineParser({
    maxTraceLines: config.maxTraceLines,
    fallbackDate: () => {
      const match = /^log_(\d{4})(\d{2})(\d{2})/.exec(watcher.activeFile ?? '');
      if (match) return `${match[1]}-${match[2]}-${match[3]}`;
      return new Date().toISOString().slice(0, 10);
    },
  });
  const buffer = new EntryBuffer(config.bufferSize);
  const stats = new StatsEngine();
  const hub = new SseHub();
  const pipeline = new Pipeline({ watcher, parser, buffer, stats, hub });
  const jellyfin = new JellyfinClient({ baseUrl: config.jellyfinUrl });

  await pipeline.start();

  const app = createApp({ config, jellyfin, buffer, stats, hub, pipeline });
  const server = app.listen(config.port, () => {
    console.log(`[logwatch] listening on :${config.port}, watching ${config.logDir}`);
  });

  const shutdown = () => { pipeline.stop(); hub.close(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[logwatch] configuration error: ${error.message}`);
    process.exit(1);
  }
  console.error('[logwatch] fatal:', error);
  process.exit(1);
});
