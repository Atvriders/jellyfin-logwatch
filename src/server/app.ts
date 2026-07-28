import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { EntryBuffer } from './entryBuffer.js';
import type { JellyfinClient } from './jellyfinClient.js';
import type { Pipeline } from './pipeline.js';
import { LockoutTracker } from './sessionAuth.js';
import type { SseHub } from './sseHub.js';
import type { StatsEngine } from './statsEngine.js';
import { authRoutes } from './routes/auth.js';
import { logRoutes } from './routes/logs.js';

export interface AppDeps {
  config: Config;
  jellyfin: JellyfinClient;
  buffer: EntryBuffer;
  stats: StatsEngine;
  hub: SseHub;
  pipeline: Pick<Pipeline, 'source'>;
  lockout?: LockoutTracker;
  clientDir?: string | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  if (deps.config.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser(deps.config.sessionSecret));

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.use('/api', authRoutes({
    config: deps.config,
    jellyfin: deps.jellyfin,
    lockout: deps.lockout ?? new LockoutTracker(),
  }));
  app.use('/api', logRoutes({
    buffer: deps.buffer, stats: deps.stats, hub: deps.hub, pipeline: deps.pipeline,
  }));

  const clientDir = deps.clientDir === undefined ? 'dist/client' : deps.clientDir;
  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => { res.sendFile(join(process.cwd(), clientDir, 'index.html')); });
  }
  return app;
}
