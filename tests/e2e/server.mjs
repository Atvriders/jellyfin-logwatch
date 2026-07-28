/**
 * The e2e fixture host. One process runs both halves of the world the app
 * talks to: a mock Jellyfin, and the REAL built server pointed at a throwaway
 * log directory. Playwright's `webServer` starts this; the specs append lines
 * to the directory whose path is written to `tests/e2e/.logdir`.
 *
 * Run it the way playwright.config.ts does — `node --import tsx
 * tests/e2e/server.mjs` — because it imports the mock straight from
 * TypeScript. Requires `npm run build` first: it boots dist/, not src/.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockJellyfin } from './mockJellyfin.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appPort = Number(process.env.E2E_PORT ?? 3999);
const jellyfinPort = Number(process.env.E2E_JELLYFIN_PORT ?? 3998);

const entryPoint = join(here, '../../dist/server/server/index.js');
if (!existsSync(entryPoint)) {
  console.error(`[e2e] ${entryPoint} is missing — run \`npm run build\` before \`npm run test:e2e\`.`);
  process.exit(1);
}

// A fresh directory per run, so a previous run's lines can never satisfy an
// assertion in this one.
const logDir = await mkdtemp(join(tmpdir(), 'logwatch-e2e-'));
await writeFile(join(here, '.logdir'), `${logDir}\n`, 'utf8');

const jellyfin = await startMockJellyfin(jellyfinPort);

Object.assign(process.env, {
  JELLYFIN_URL: `http://127.0.0.1:${jellyfinPort}`,
  // Deliberately left set: the app no longer reads it, and the owner's
  // deployed compose file still passes it. Booting the REAL built server with
  // this leftover in the environment is the end-to-end proof that an unknown
  // variable is ignored rather than fatal. Do not remove it.
  JELLYFIN_API_KEY: 'k',
  SESSION_SECRET: 'e2e',
  LOG_DIR: logDir,
  PORT: String(appPort),
  // Fast enough that a test never waits on the clock, slow enough to stay a
  // poll (the mount is read-only and may be FUSE — never a watch).
  POLL_INTERVAL_MS: '100',
  RESCAN_INTERVAL_MS: '100',
  NODE_ENV: 'production',
});

// The built entry point reads process.env at import time, so it goes last.
await import(pathToFileURL(entryPoint).href);

process.on('exit', () => { rmSync(logDir, { recursive: true, force: true }); });
for (const signal of ['SIGTERM', 'SIGINT']) {
  // The app installs its own graceful handler, but an open SSE stream can hold
  // server.close() forever; leaving on our own keeps teardown bounded.
  process.on(signal, () => { jellyfin.close(); process.exit(0); });
}
