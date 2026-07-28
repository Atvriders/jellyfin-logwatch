# Jellyfin Logwatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-container web dashboard that tails the Jellyfin log file on an Unraid host and renders it as a live, parsed, filterable feed behind a Jellyfin-account login.

**Architecture:** One Node process polls a read-only bind-mounted log directory, parses Serilog-formatted lines into structured entries (folding stack traces into single entries), keeps them in a fixed-size in-memory ring with a 15-minute rolling stats window, and pushes them to a React SPA over Server-Sent Events. Login verifies passwords against Jellyfin itself; the API key is used only to list users for the login screen.

**Tech Stack:** Node 24 (runtime) / TypeScript strict · Express 5 · React 19 · Vite 7 · vitest · Playwright · Docker · GitHub Actions

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-26-jellyfin-logwatch-design.md`. Where this plan and the spec disagree, the spec wins.
- **Commit policy (overrides the skill default):** do **NOT** commit per task. Every task ends with a verification step only. A single commit is made at the very end, after full verification (typecheck + lint + build + unit + integration + e2e). This is a standing user preference.
- TypeScript `strict: true`. No `any` in committed code except in explicitly-typed test doubles.
- Node 20.20.2 is the local sandbox version and satisfies Vite 7's `^20.19 || >=22.12`. CI and the runtime image use Node 24.
- The log mount is **read-only**. Nothing in this codebase may open a file in the log directory for writing.
- **Polling, never inotify, for correctness.** Unraid `/mnt/user` is FUSE (shfs); `fs.watch` may never fire. All watcher tests must pass with `fs.watch` unavailable.
- Log text is rendered `textContent`-only in the client. No `innerHTML`, no `dangerouslySetInnerHTML`, anywhere.
- Never drop a log line. Every byte read must surface somewhere in the feed.
- No database, no writable volume, no outbound network calls except to `JELLYFIN_URL`.
- Repo and GHCR package are **public**.
- All Jellyfin requests that authenticate a user must send the
  `Authorization: MediaBrowser Client="Jellyfin Logwatch", Device="server", DeviceId="jellyfin-logwatch", Version="1.0.0"` header; Jellyfin rejects `/Users/AuthenticateByName` without it.

## Dependency Waves (for parallel execution)

- **Wave 1:** Task 1
- **Wave 2:** Tasks 2, 3, 4, 5, 6, 7 (fully independent of each other)
- **Wave 3:** Tasks 8, 9
- **Wave 4:** Tasks 10, 11, 16, 17
- **Wave 5:** Tasks 12, 13, 14
- **Wave 6:** Task 15 (visual design pass), then Task 18 (e2e), then Task 19 (final verification + single commit)

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | `Level`, `LogEntry`, `Stats`, `SourceState`, `Snapshot`, `LoginUser`, `SessionInfo`, SSE event names. Imported by both server and client. |
| `src/server/config.ts` | Parse + validate env into a `Config`; fail fast naming the missing variable. |
| `src/server/logParser.ts` | Pure line → entry parsing, trace folding, level mapping, trace cap. |
| `src/server/logWatcher.ts` | Active-file selection, byte-offset polling, rotation, truncation, partial-line carry. |
| `src/server/entryBuffer.ts` | Fixed ring, `seq` assignment, `since(seq)` replay. |
| `src/server/statsEngine.ts` | 1-minute buckets over a 15-minute window; counts, sparkline, top components, rate. |
| `src/server/jellyfinClient.ts` | `listUsers`, `authenticate`, `revoke`, `fetchAvatar`; typed error classes. |
| `src/server/sessionAuth.ts` | Signed-cookie sessions, `requireAuth` middleware, IP lockout tracker. |
| `src/server/sseHub.ts` | SSE client registry, 10 Hz batching, heartbeat, `Last-Event-ID` replay. |
| `src/server/pipeline.ts` | Wires watcher → parser → buffer → stats → hub. The only stateful glue. |
| `src/server/routes/auth.ts` | `/api/session`, `/api/users`, `/api/users/:id/avatar`, `/api/login`, `/api/logout`. |
| `src/server/routes/logs.ts` | `/api/snapshot`, `/api/stream`. |
| `src/server/app.ts` | Express app factory (routes + static SPA), no `listen`. |
| `src/server/index.ts` | Entry point: config → construct → `listen`. |
| `src/client/main.tsx` | React root. |
| `src/client/App.tsx` | Session gate: login screen vs dashboard. |
| `src/client/api.ts` | Typed `fetch` wrappers for every REST route. |
| `src/client/useLogStream.ts` | SSE subscription + entry/stats state + reconnect/resnapshot. |
| `src/client/components/Login.tsx` | User grid, avatar, password, error states. |
| `src/client/components/StatsStrip.tsx` | Level counts, sparkline, noisy components, rate, active file. |
| `src/client/components/Sparkline.tsx` | Inline SVG sparkline. |
| `src/client/components/FilterBar.tsx` | Level toggles, component filter, search, follow/pause. |
| `src/client/components/Feed.tsx` | Virtualized list, follow-at-bottom, jump pill, day dividers. |
| `src/client/components/EntryRow.tsx` | One entry; collapsible trace; `textContent`-only rendering. |
| `src/client/filter.ts` | Pure `applyFilters(entries, filters)` — unit tested without React. |
| `tests/unit/*.test.ts` | Per-module unit tests. |
| `tests/integration/stream.test.ts` | Temp log file → SSE end-to-end. |
| `tests/e2e/*.spec.ts` | Playwright against a mock Jellyfin. |
| `tests/fixtures/efcore-trace.log` | The real 60-line EF Core trace from the reported screenshot. |
| `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `.github/workflows/ci.yml` | Ship + CI. |

---

### Task 1: Scaffold, shared types, and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore` (extend), `index.html`
- Create: `src/shared/types.ts`
- Create: `src/server/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: everything below imports `src/shared/types.ts`; servers import `loadConfig(env): Config` and `ConfigError` from `src/server/config.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "jellyfin-logwatch",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.19" },
  "scripts": {
    "dev:server": "tsx watch src/server/index.ts",
    "dev:client": "vite",
    "build": "npm run build:client && npm run build:server",
    "build:client": "vite build",
    "build:server": "tsc -p tsconfig.server.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "start": "node dist/server/server/index.js"
  },
  "dependencies": {
    "cookie-parser": "^1.4.7",
    "express": "^5.1.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.50.0",
    "@tanstack/react-virtual": "^3.13.0",
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/supertest": "^6.0.2",
    "@vitejs/plugin-react": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
```

Note: `react`, `react-dom` and `@tanstack/react-virtual` are devDependencies on purpose — the client is compiled into static assets by Vite, so the runtime image never installs them.

- [ ] **Step 2: Create the TypeScript configs**

`tsconfig.json` (client + shared, used by Vite and the typecheck):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": ["vite/client"]
  },
  "include": ["src/client", "src/shared", "vite.config.ts"]
}
```

`tsconfig.server.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist/server",
    "rootDir": "src",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/server", "src/shared"]
}
```

Because `module: NodeNext` is used for the server, **every relative import in `src/server` and `src/shared` must carry a `.js` extension** (e.g. `import { loadConfig } from './config.js'`). Vite and vitest resolve those fine.

- [ ] **Step 3: Create `vite.config.ts` and `vitest.config.ts`**

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Jellyfin Logwatch</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/shared/types.ts`**

```ts
export type Level =
  | 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'raw';

export const LEVELS: readonly Level[] = [
  'verbose', 'debug', 'info', 'warn', 'error', 'fatal', 'raw',
] as const;

export interface LogEntry {
  seq: number;
  ts: string | null;
  level: Level;
  thread: number | null;
  component: string | null;
  message: string;
  trace: string[];
  traceTruncated: boolean;
}

export interface Stats {
  windowMinutes: number;
  counts: Record<Level, number>;
  sparkline: number[];
  topComponents: Array<{ component: string; count: number }>;
  linesPerSecond: number;
}

export interface SourceState {
  file: string | null;
  waiting: boolean;
}

export interface Snapshot {
  entries: LogEntry[];
  stats: Stats;
  source: SourceState;
  lastSeq: number;
}

export interface LoginUser {
  id: string;
  name: string;
  hasAvatar: boolean;
}

export interface SessionInfo {
  authenticated: boolean;
  username: string | null;
}

export type SseEventName =
  | 'entries' | 'stats' | 'rotate' | 'waiting' | 'resnapshot';
```

- [ ] **Step 6: Write the failing config test**

`tests/unit/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/server/config.js';

const base = {
  JELLYFIN_URL: 'http://your-jellyfin-host:8096/',
  JELLYFIN_API_KEY: 'abc123',
  SESSION_SECRET: 's3cret',
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.logDir).toBe('/logs');
    expect(cfg.port).toBe(3000);
    expect(cfg.bufferSize).toBe(5000);
    expect(cfg.pollIntervalMs).toBe(750);
    expect(cfg.rescanIntervalMs).toBe(5000);
    expect(cfg.startupTailBytes).toBe(262144);
    expect(cfg.maxTraceLines).toBe(500);
    expect(cfg.trustProxy).toBe(false);
  });

  it('strips a trailing slash from the Jellyfin URL', () => {
    expect(loadConfig({ ...base }).jellyfinUrl).toBe('http://your-jellyfin-host:8096');
  });

  it('names the missing variable', () => {
    expect(() => loadConfig({ ...base, JELLYFIN_API_KEY: '' }))
      .toThrow(/JELLYFIN_API_KEY/);
    expect(() => loadConfig({ ...base, JELLYFIN_API_KEY: '' }))
      .toThrow(ConfigError);
  });

  it('rejects a non-numeric or non-positive override', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, BUFFER_SIZE: '0' })).toThrow(/BUFFER_SIZE/);
  });

  it('treats TRUST_PROXY=1 as true and anything else as false', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });
});
```

- [ ] **Step 7: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — cannot resolve `src/server/config.js`.

- [ ] **Step 8: Implement `src/server/config.ts`**

```ts
export class ConfigError extends Error {}

export interface Config {
  jellyfinUrl: string;
  jellyfinApiKey: string;
  sessionSecret: string;
  logDir: string;
  port: number;
  bufferSize: number;
  pollIntervalMs: number;
  rescanIntervalMs: number;
  startupTailBytes: number;
  maxTraceLines: number;
  trustProxy: boolean;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `${name} is required. Set it in your compose file or .env — see .env.example.`,
    );
  }
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    jellyfinUrl: required(env, 'JELLYFIN_URL').replace(/\/+$/, ''),
    jellyfinApiKey: required(env, 'JELLYFIN_API_KEY'),
    sessionSecret: required(env, 'SESSION_SECRET'),
    logDir: env.LOG_DIR?.trim() || '/logs',
    port: positiveInt(env, 'PORT', 3000),
    bufferSize: positiveInt(env, 'BUFFER_SIZE', 5000),
    pollIntervalMs: positiveInt(env, 'POLL_INTERVAL_MS', 750),
    rescanIntervalMs: positiveInt(env, 'RESCAN_INTERVAL_MS', 5000),
    startupTailBytes: positiveInt(env, 'STARTUP_TAIL_BYTES', 262144),
    maxTraceLines: positiveInt(env, 'MAX_TRACE_LINES', 500),
    trustProxy: env.TRUST_PROXY?.trim() === '1',
  };
}
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/config.test.ts` → PASS (5 tests).

- [ ] **Step 10: Verify the toolchain builds**

Run: `npm run typecheck`
Expected: no errors. Do **not** commit (see the commit policy in Global Constraints).

---

### Task 2: LineParser

**Files:**
- Create: `src/server/logParser.ts`
- Create: `tests/fixtures/efcore-trace.log`
- Test: `tests/unit/logParser.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `Level` from `src/shared/types.js`.
- Produces:
  - `type ParsedEntry = Omit<LogEntry, 'seq'>`
  - `class LineParser { constructor(opts: { maxTraceLines: number; fallbackDate: () => string }); write(lines: string[]): ParsedEntry[]; flush(): ParsedEntry[]; setFallbackDate(date: string): void }`
  - `write()` returns every entry completed by these lines (all but the still-open last one). `flush()` returns the open entry, if any, and clears it. `fallbackDate` returns `YYYY-MM-DD` and is only consulted by the date-less secondary format.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/efcore-trace.log` — one ERR start line followed by the exact continuation lines from the reported screenshot. Begin the file with:

```
[2026-07-26 22:14:03.123 -05:00] [ERR] [42] Jellyfin.Database.Implementations.JellyfinDbContext: Error saving changes
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 5: 'database is locked'.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(IRelationalConnection connection, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Update.Internal.BatchExecutor.ExecuteAsync(IEnumerable`1 commandBatches, IRelationalConnection connection, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.RelationalDatabase.SaveChangesAsync(IList`1 entries, CancellationToken cancellationToken)
   at Jellyfin.Database.Implementations.JellyfinDbContext.<>c__DisplayClass62_0.<<SaveChangesAsync>b__0>d.MoveNext()
--- End of stack trace from previous location ---
   at Jellyfin.Server.Implementations.Devices.DeviceManager.UpdateDevice(Device device)
   at Jellyfin.Server.Implementations.Security.AuthorizationContext.GetAuthorizationInfo(HttpRequest requestContext)
   at Emby.Server.Implementations.HttpServer.Security.AuthService.Authenticate(HttpRequest request)
   at Jellyfin.Api.Auth.CustomAuthenticationHandler.HandleAuthenticateAsync()
   at Jellyfin.Api.Middleware.ExceptionMiddleware.Invoke(HttpContext context)
```

then pad the trace with repeated `   at ...` lines until the file holds exactly **61** lines: 1 start line + 60 trace lines. The test asserts that count, so the fixture and the assertion must agree.

- [ ] **Step 2: Write the failing parser test**

`tests/unit/logParser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LineParser } from '../../src/server/logParser.js';

const opts = { maxTraceLines: 500, fallbackDate: () => '2026-07-26' };
const parse = (lines: string[], o = opts) => {
  const p = new LineParser(o);
  return [...p.write(lines), ...p.flush()];
};

describe('LineParser', () => {
  it('parses the primary Jellyfin file template', () => {
    const [e] = parse([
      '[2026-07-26 22:14:05.001 -05:00] [INF] [7] Emby.Server.Implementations.Session.SessionManager: Playback start',
    ]);
    expect(e).toMatchObject({
      level: 'info',
      thread: 7,
      component: 'Emby.Server.Implementations.Session.SessionManager',
      message: 'Playback start',
      trace: [],
      traceTruncated: false,
    });
    expect(e!.ts).toBe(new Date('2026-07-26T22:14:05.001-05:00').toISOString());
  });

  it('folds a 60-line stack trace into ONE entry', () => {
    const lines = readFileSync('tests/fixtures/efcore-trace.log', 'utf8')
      .split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(61);
    const entries = parse(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('error');
    expect(entries[0]!.trace).toHaveLength(60);
    expect(entries[0]!.traceTruncated).toBe(false);
  });

  it('maps every Serilog level code', () => {
    const codes: Array<[string, string]> = [
      ['VRB', 'verbose'], ['DBG', 'debug'], ['INF', 'info'],
      ['WRN', 'warn'], ['ERR', 'error'], ['FTL', 'fatal'],
    ];
    for (const [code, level] of codes) {
      const [e] = parse([`[2026-07-26 01:02:03.000 +00:00] [${code}] [1] A.B: m`]);
      expect(e!.level).toBe(level);
    }
  });

  it('does not let a message containing ": " swallow the component', () => {
    const [e] = parse([
      '[2026-07-26 01:02:03.000 +00:00] [WRN] [3] Jellyfin.Api.Http: GET /Items: 404 Not Found',
    ]);
    expect(e!.component).toBe('Jellyfin.Api.Http');
    expect(e!.message).toBe('GET /Items: 404 Not Found');
  });

  it('parses the date-less console template using the fallback date', () => {
    const [e] = parse(['[22:14:07] [INF] [SessionManager] Session ended']);
    expect(e!.component).toBe('SessionManager');
    expect(e!.message).toBe('Session ended');
    expect(e!.ts!.startsWith('2026-07-26')).toBe(true);
    expect(e!.thread).toBeNull();
  });

  it('emits an orphan continuation as a raw entry', () => {
    const entries = parse(['   at Some.Method()', '[2026-07-26 01:02:03.000 +00:00] [INF] [1] A.B: ok']);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'raw', message: '   at Some.Method()', ts: null, component: null });
    expect(entries[1]!.level).toBe('info');
  });

  it('caps the trace and flags truncation', () => {
    const lines = ['[2026-07-26 01:02:03.000 +00:00] [ERR] [1] A.B: boom',
      ...Array.from({ length: 10 }, (_, i) => `   at F${i}()`)];
    const [e] = parse(lines, { ...opts, maxTraceLines: 4 });
    expect(e!.trace).toHaveLength(5);
    expect(e!.trace[4]).toBe('… 6 more lines truncated');
    expect(e!.traceTruncated).toBe(true);
  });

  it('holds the open entry until the next start line or flush', () => {
    const p = new LineParser(opts);
    expect(p.write(['[2026-07-26 01:02:03.000 +00:00] [INF] [1] A.B: one'])).toHaveLength(0);
    expect(p.write(['[2026-07-26 01:02:04.000 +00:00] [INF] [1] A.B: two'])).toHaveLength(1);
    expect(p.flush()).toHaveLength(1);
    expect(p.flush()).toHaveLength(0);
  });

  it('never drops a line: an unparseable first line still surfaces', () => {
    const entries = parse(['total garbage \x00 bytes']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe('total garbage \x00 bytes');
    expect(entries[0]!.level).toBe('raw');
  });

  it('treats an unknown level code as raw but keeps the message', () => {
    const [e] = parse(['[2026-07-26 01:02:03.000 +00:00] [XYZ] [1] A.B: hmm']);
    expect(e!.level).toBe('raw');
    expect(e!.message).toBe('hmm');
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/logParser.test.ts`
Expected: FAIL — cannot resolve `src/server/logParser.js`.

- [ ] **Step 4: Implement `src/server/logParser.ts`**

```ts
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
        ts: toIso(`${this.opts.fallbackDate()} ${secondary[1]!}.000`),
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
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/logParser.test.ts` → PASS (10 tests).

Note the trace-cap arithmetic the test pins: with `maxTraceLines: 4` and 10 trace lines, 4 are kept, 6 are dropped, and a 5th array element is the truncation marker.

- [ ] **Step 6: Verify types**

Run: `npm run typecheck` → no errors. No commit.

---

### Task 3: EntryBuffer

**Files:**
- Create: `src/server/entryBuffer.ts`
- Test: `tests/unit/entryBuffer.test.ts`

**Interfaces:**
- Consumes: `LogEntry` from `src/shared/types.js`; `ParsedEntry` from `src/server/logParser.js`.
- Produces: `class EntryBuffer { constructor(size: number); add(entry: ParsedEntry): LogEntry; addAll(entries: ParsedEntry[]): LogEntry[]; snapshot(limit?: number): LogEntry[]; since(seq: number): LogEntry[] | null; get lastSeq(): number; get size(): number }`. `since(seq)` returns entries with `seq > seq`, or `null` when `seq` has been evicted and the client must resnapshot.

- [ ] **Step 1: Write the failing test**

`tests/unit/entryBuffer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import type { ParsedEntry } from '../../src/server/logParser.js';

const entry = (message: string): ParsedEntry => ({
  ts: null, level: 'info', thread: null, component: 'A.B',
  message, trace: [], traceTruncated: false,
});

describe('EntryBuffer', () => {
  it('assigns monotonic seq numbers starting at 1', () => {
    const buffer = new EntryBuffer(10);
    expect(buffer.add(entry('a')).seq).toBe(1);
    expect(buffer.add(entry('b')).seq).toBe(2);
    expect(buffer.lastSeq).toBe(2);
  });

  it('evicts oldest first and keeps seq monotonic across eviction', () => {
    const buffer = new EntryBuffer(3);
    buffer.addAll([entry('a'), entry('b'), entry('c'), entry('d')]);
    expect(buffer.snapshot().map((e) => e.message)).toEqual(['b', 'c', 'd']);
    expect(buffer.lastSeq).toBe(4);
    expect(buffer.size).toBe(3);
  });

  it('limits a snapshot to the newest N entries', () => {
    const buffer = new EntryBuffer(10);
    buffer.addAll([entry('a'), entry('b'), entry('c')]);
    expect(buffer.snapshot(2).map((e) => e.message)).toEqual(['b', 'c']);
  });

  it('replays entries newer than a seq still in the ring', () => {
    const buffer = new EntryBuffer(10);
    buffer.addAll([entry('a'), entry('b'), entry('c')]);
    expect(buffer.since(1)!.map((e) => e.message)).toEqual(['b', 'c']);
    expect(buffer.since(3)).toEqual([]);
  });

  it('returns null when the requested seq has been evicted', () => {
    const buffer = new EntryBuffer(2);
    buffer.addAll([entry('a'), entry('b'), entry('c')]);
    expect(buffer.since(1)).toBeNull();
  });

  it('accepts seq 0 on an empty buffer as a full replay', () => {
    const buffer = new EntryBuffer(5);
    expect(buffer.since(0)).toEqual([]);
    buffer.add(entry('a'));
    expect(buffer.since(0)!.map((e) => e.message)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/entryBuffer.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/entryBuffer.ts`**

```ts
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
    const oldest = this.entries[0];
    if (oldest && seq < oldest.seq - 1) return null;
    return this.entries.filter((entry) => entry.seq > seq);
  }

  get lastSeq(): number { return this.seq; }
  get size(): number { return this.entries.length; }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/entryBuffer.test.ts` → PASS (6 tests). No commit.

---

### Task 4: StatsEngine

**Files:**
- Create: `src/server/statsEngine.ts`
- Test: `tests/unit/statsEngine.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `Stats`, `Level`, `LEVELS` from `src/shared/types.js`.
- Produces: `class StatsEngine { constructor(opts?: { windowMinutes?: number; now?: () => number }); record(entry: LogEntry): void; snapshot(): Stats }`. `snapshot()` expires stale buckets before computing, so no separate `tick()` is needed. `sparkline` is always `windowMinutes` numbers, oldest first, zero-filled.

- [ ] **Step 1: Write the failing test**

`tests/unit/statsEngine.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/statsEngine.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/statsEngine.ts`**

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/statsEngine.test.ts` → PASS (6 tests). No commit.

---

### Task 5: LogFileWatcher

**Files:**
- Create: `src/server/logWatcher.ts`
- Test: `tests/unit/logWatcher.test.ts`

**Interfaces:**
- Consumes: nothing but `node:fs/promises` and `node:events`.
- Produces:

```ts
class LogFileWatcher extends EventEmitter {
  constructor(opts: {
    dir: string;
    pollIntervalMs: number;
    rescanIntervalMs: number;
    startupTailBytes: number;
  });
  start(): Promise<void>;   // performs the initial rescan + tail read
  stop(): void;
  poll(): Promise<void>;    // public for deterministic tests
  rescan(): Promise<void>;  // public for deterministic tests
  get activeFile(): string | null;
  get waiting(): boolean;
}
```

Events: `lines(string[])`, `idle()` (a poll that found no growth), `rotate(file: string)`, `waiting(boolean)`, `error(Error)`.

Tests drive `poll()`/`rescan()` directly and never start the timers, so they are deterministic and do not depend on `fs.watch`.

- [ ] **Step 1: Write the failing test**

`tests/unit/logWatcher.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/logWatcher.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/logWatcher.ts`**

```ts
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
    this.running = true;
    await this.rescan();
    await this.poll();
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
      this.emit('error', error as Error);
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

  private setWaiting(value: boolean): void {
    if (this.isWaiting === value && this.running) return;
    this.isWaiting = value;
    this.emit('waiting', value);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/logWatcher.test.ts` → PASS (9 tests).

If the "selects the newest" test is flaky because both fixtures get the same mtime, the `utimes` call in the test is what separates them — keep it.

- [ ] **Step 5: Verify types**

Run: `npm run typecheck` → no errors. No commit.

---

### Task 6: JellyfinClient

**Files:**
- Create: `src/server/jellyfinClient.ts`
- Test: `tests/unit/jellyfinClient.test.ts`

**Interfaces:**
- Consumes: `LoginUser` from `src/shared/types.js`.
- Produces:

```ts
class JellyfinUnreachableError extends Error {}
class JellyfinAuthError extends Error {}
class JellyfinClient {
  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch });
  listUsers(): Promise<LoginUser[]>;
  authenticate(username: string, password: string): Promise<{ userId: string; name: string; token: string }>;
  revoke(token: string): Promise<void>;
  fetchAvatar(userId: string): Promise<{ body: Buffer; contentType: string } | null>;
}
const AUTH_HEADER: string;  // the MediaBrowser Authorization value
```

- [ ] **Step 1: Write the failing test**

`tests/unit/jellyfinClient.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  JellyfinClient, JellyfinAuthError, JellyfinUnreachableError,
} from '../../src/server/jellyfinClient.js';

const make = (impl: typeof fetch) =>
  new JellyfinClient({ baseUrl: 'http://jf:8096', apiKey: 'KEY', fetchImpl: impl });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('JellyfinClient', () => {
  it('lists enabled users and reports avatar availability', async () => {
    const impl = vi.fn(async () => json([
      { Id: '1', Name: 'james', PrimaryImageTag: 'tag', Policy: { IsDisabled: false } },
      { Id: '2', Name: 'guest', Policy: { IsDisabled: false } },
      { Id: '3', Name: 'old', Policy: { IsDisabled: true } },
    ])) as unknown as typeof fetch;
    const users = await make(impl).listUsers();
    expect(users).toEqual([
      { id: '1', name: 'james', hasAvatar: true },
      { id: '2', name: 'guest', hasAvatar: false },
    ]);
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://jf:8096/Users');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Emby-Token': 'KEY' });
  });

  it('sends the MediaBrowser Authorization header when authenticating', async () => {
    const impl = vi.fn(async () => json({
      AccessToken: 'tok', User: { Id: '1', Name: 'james' },
    })) as unknown as typeof fetch;
    const result = await make(impl).authenticate('james', 'pw');
    expect(result).toEqual({ userId: '1', name: 'james', token: 'tok' });
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://jf:8096/Users/AuthenticateByName');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toContain('MediaBrowser Client="Jellyfin Logwatch"');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ Username: 'james', Pw: 'pw' });
  });

  it('throws JellyfinAuthError on 401', async () => {
    const impl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'bad')).rejects.toBeInstanceOf(JellyfinAuthError);
  });

  it('throws JellyfinUnreachableError when fetch rejects', async () => {
    const impl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'pw')).rejects.toBeInstanceOf(JellyfinUnreachableError);
    await expect(make(impl).listUsers()).rejects.toBeInstanceOf(JellyfinUnreachableError);
  });

  it('throws JellyfinUnreachableError on a 5xx', async () => {
    const impl = vi.fn(async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    await expect(make(impl).authenticate('james', 'pw')).rejects.toBeInstanceOf(JellyfinUnreachableError);
  });

  it('revokes a token with that token, not the API key, and swallows failures', async () => {
    const impl = vi.fn(async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    await make(impl).revoke('tok');
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://jf:8096/Sessions/Logout');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Emby-Token': 'tok' });

    const failing = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    await expect(make(failing).revoke('tok')).resolves.toBeUndefined();
  });

  it('returns null for a missing avatar', async () => {
    const impl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await make(impl).fetchAvatar('1')).toBeNull();
  });

  it('returns avatar bytes and content type', async () => {
    const impl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/png' },
    })) as unknown as typeof fetch;
    const avatar = await make(impl).fetchAvatar('1');
    expect(avatar!.contentType).toBe('image/png');
    expect([...avatar!.body]).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/jellyfinClient.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/jellyfinClient.ts`**

```ts
import type { LoginUser } from '../shared/types.js';

export class JellyfinUnreachableError extends Error {}
export class JellyfinAuthError extends Error {}

export const AUTH_HEADER =
  'MediaBrowser Client="Jellyfin Logwatch", Device="server", DeviceId="jellyfin-logwatch", Version="1.0.0"';

interface JellyfinUser {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
  Policy?: { IsDisabled?: boolean };
}

export interface JellyfinClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class JellyfinClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JellyfinClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string): string { return `${this.opts.baseUrl}${path}`; }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), init);
    } catch (error) {
      throw new JellyfinUnreachableError(`Jellyfin request to ${path} failed: ${String(error)}`);
    }
  }

  async listUsers(): Promise<LoginUser[]> {
    const response = await this.call('/Users', {
      headers: { 'X-Emby-Token': this.opts.apiKey, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new JellyfinUnreachableError(`Jellyfin /Users returned ${response.status}`);
    }
    const users = (await response.json()) as JellyfinUser[];
    return users
      .filter((user) => user.Policy?.IsDisabled !== true)
      .map((user) => ({ id: user.Id, name: user.Name, hasAvatar: Boolean(user.PrimaryImageTag) }));
  }

  async authenticate(username: string, password: string) {
    const response = await this.call('/Users/AuthenticateByName', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new JellyfinAuthError('Invalid username or password');
    }
    if (!response.ok) {
      throw new JellyfinUnreachableError(`Jellyfin authentication returned ${response.status}`);
    }
    const body = (await response.json()) as { AccessToken: string; User: { Id: string; Name: string } };
    return { userId: body.User.Id, name: body.User.Name, token: body.AccessToken };
  }

  async revoke(token: string): Promise<void> {
    try {
      await this.fetchImpl(this.url('/Sessions/Logout'), {
        method: 'POST',
        headers: { 'X-Emby-Token': token, Authorization: AUTH_HEADER },
      });
    } catch {
      // Best effort: the token expires on its own; never fail a login over this.
    }
  }

  async fetchAvatar(userId: string): Promise<{ body: Buffer; contentType: string } | null> {
    const response = await this.call(`/Users/${encodeURIComponent(userId)}/Images/Primary`, {
      headers: { 'X-Emby-Token': this.opts.apiKey },
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return { body: buffer, contentType: response.headers.get('content-type') ?? 'image/jpeg' };
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/jellyfinClient.test.ts` → PASS (8 tests). No commit.

---

### Task 7: SessionAuth and lockout

**Files:**
- Create: `src/server/sessionAuth.ts`
- Test: `tests/unit/sessionAuth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
class LockoutTracker {
  constructor(opts?: { maxAttempts?: number; windowMs?: number; blockMs?: number; now?: () => number });
  isBlocked(ip: string): boolean;
  retryAfterMs(ip: string): number;
  recordFailure(ip: string): void;
  reset(ip: string): void;
}
const SESSION_COOKIE = 'logwatch_session';
interface SessionPayload { username: string; userId: string; issuedAt: number }
function readSession(req): SessionPayload | null;
function writeSession(res, payload: SessionPayload, secure: boolean): void;
function clearSession(res): void;
function requireAuth(req, res, next): void;     // 401 { error: 'unauthorized' } when absent
function clientIp(req, trustProxy: boolean): string;
```

Defaults: `maxAttempts: 5`, `windowMs: 300_000`, `blockMs: 900_000`.

- [ ] **Step 1: Write the failing test**

`tests/unit/sessionAuth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LockoutTracker, clientIp } from '../../src/server/sessionAuth.js';
import type { Request } from 'express';

describe('LockoutTracker', () => {
  it('blocks only after the threshold is crossed', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 4; i++) tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
    tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(true);
  });

  it('expires the block after blockMs', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 5; i++) tracker.recordFailure('1.1.1.1');
    now += 900_001;
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
  });

  it('forgets failures older than the window', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 4; i++) tracker.recordFailure('1.1.1.1');
    now += 300_001;
    tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
  });

  it('tracks IPs independently and resets on success', () => {
    const tracker = new LockoutTracker({ now: () => 0 });
    for (let i = 0; i < 5; i++) tracker.recordFailure('1.1.1.1');
    expect(tracker.isBlocked('2.2.2.2')).toBe(false);
    tracker.reset('1.1.1.1');
    expect(tracker.isBlocked('1.1.1.1')).toBe(false);
  });

  it('reports a positive retryAfterMs while blocked', () => {
    let now = 0;
    const tracker = new LockoutTracker({ now: () => now });
    for (let i = 0; i < 5; i++) tracker.recordFailure('1.1.1.1');
    expect(tracker.retryAfterMs('1.1.1.1')).toBeGreaterThan(0);
    expect(tracker.retryAfterMs('2.2.2.2')).toBe(0);
  });
});

describe('clientIp', () => {
  const req = (xff: string | undefined, socket = '10.0.0.1') =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: socket } }) as unknown as Request;

  it('uses the socket address when not trusting a proxy', () => {
    expect(clientIp(req('9.9.9.9'), false)).toBe('10.0.0.1');
  });

  it('uses the rightmost X-Forwarded-For token when trusting a proxy', () => {
    expect(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), true)).toBe('3.3.3.3');
  });

  it('falls back to the socket address when the header is absent', () => {
    expect(clientIp(req(undefined), true)).toBe('10.0.0.1');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/sessionAuth.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/sessionAuth.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'logwatch_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  username: string;
  userId: string;
  issuedAt: number;
}

export interface LockoutOptions {
  maxAttempts?: number;
  windowMs?: number;
  blockMs?: number;
  now?: () => number;
}

export class LockoutTracker {
  private readonly failures = new Map<string, number[]>();
  private readonly blocked = new Map<string, number>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(opts: LockoutOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.windowMs = opts.windowMs ?? 300_000;
    this.blockMs = opts.blockMs ?? 900_000;
    this.now = opts.now ?? (() => Date.now());
  }

  isBlocked(ip: string): boolean { return this.retryAfterMs(ip) > 0; }

  retryAfterMs(ip: string): number {
    const until = this.blocked.get(ip);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.blocked.delete(ip);
      this.failures.delete(ip);
      return 0;
    }
    return remaining;
  }

  recordFailure(ip: string): void {
    const now = this.now();
    const recent = (this.failures.get(ip) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    this.failures.set(ip, recent);
    if (recent.length >= this.maxAttempts) {
      this.blocked.set(ip, now + this.blockMs);
    }
  }

  reset(ip: string): void {
    this.failures.delete(ip);
    this.blocked.delete(ip);
  }
}

export function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header.join(',') : header;
    const tokens = (raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const rightmost = tokens[tokens.length - 1];
    if (rightmost) return rightmost;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function readSession(req: Request): SessionPayload | null {
  const raw = req.signedCookies?.[SESSION_COOKIE];
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as SessionPayload;
    if (typeof parsed.username !== 'string' || typeof parsed.userId !== 'string') return null;
    if (Date.now() - parsed.issuedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSession(res: Response, payload: SessionPayload, secure: boolean): void {
  res.cookie(SESSION_COOKIE, JSON.stringify(payload), {
    httpOnly: true, sameSite: 'lax', secure, signed: true, maxAge: MAX_AGE_MS, path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (readSession(req)) { next(); return; }
  res.status(401).json({ error: 'unauthorized' });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/sessionAuth.test.ts` → PASS (8 tests). No commit.

---

### Task 8: SSE hub and pipeline

**Files:**
- Create: `src/server/sseHub.ts`
- Create: `src/server/pipeline.ts`
- Test: `tests/unit/sseHub.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `Stats`, `SourceState` from types; `EntryBuffer`, `StatsEngine`, `LineParser`, `LogFileWatcher`.
- Produces:

```ts
class SseHub {
  constructor(opts?: { flushIntervalMs?: number; maxBatch?: number; heartbeatMs?: number });
  addClient(res: Response): () => void;      // returns a detach function
  publishEntries(entries: LogEntry[]): void; // batched
  publishStats(stats: Stats): void;          // coalesced, latest wins
  publish(event: 'rotate' | 'waiting' | 'resnapshot', data: unknown): void; // immediate
  flush(): void;                             // public for deterministic tests
  get clientCount(): number;
  close(): void;
}

class Pipeline {
  constructor(deps: { watcher; parser; buffer; stats; hub; statsIntervalMs?: number });
  start(): Promise<void>;
  stop(): void;
  source(): SourceState;
}
```

- [ ] **Step 1: Write the failing SSE test**

`tests/unit/sseHub.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SseHub } from '../../src/server/sseHub.js';
import type { Response } from 'express';
import type { LogEntry } from '../../src/shared/types.js';

const fakeRes = () => {
  const chunks: string[] = [];
  const handlers = new Map<string, () => void>();
  return {
    chunks,
    res: {
      write: (chunk: string) => { chunks.push(chunk); return true; },
      end: vi.fn(),
      on: (event: string, handler: () => void) => { handlers.set(event, handler); },
      flushHeaders: vi.fn(),
      setHeader: vi.fn(),
    } as unknown as Response,
    close: () => handlers.get('close')?.(),
  };
};

const entry = (seq: number): LogEntry => ({
  seq, ts: null, level: 'info', thread: null, component: 'A',
  message: `m${seq}`, trace: [], traceTruncated: false,
});

describe('SseHub', () => {
  it('batches entries until flush and emits a single event with the last id', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publishEntries([entry(1), entry(2)]);
    expect(client.chunks.join('')).toBe('');
    hub.flush();
    const payload = client.chunks.join('');
    expect(payload).toContain('event: entries');
    expect(payload).toContain('id: 2');
    expect(payload).toMatch(/data: .*"m1".*"m2"/);
    hub.close();
  });

  it('caps a flush at maxBatch, keeping the newest entries', () => {
    const hub = new SseHub({ flushIntervalMs: 0, maxBatch: 2 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publishEntries([entry(1), entry(2), entry(3)]);
    hub.flush();
    const payload = client.chunks.join('');
    expect(payload).toContain('"m3"');
    expect(payload).not.toContain('"m1"');
    expect(payload).toContain('id: 3');
    hub.close();
  });

  it('coalesces stats so only the latest is sent per flush', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publishStats({ windowMinutes: 15, counts: {} as never, sparkline: [1], topComponents: [], linesPerSecond: 1 });
    hub.publishStats({ windowMinutes: 15, counts: {} as never, sparkline: [2], topComponents: [], linesPerSecond: 2 });
    hub.flush();
    const payload = client.chunks.join('');
    expect(payload.match(/event: stats/g)).toHaveLength(1);
    expect(payload).toContain('"linesPerSecond":2');
    hub.close();
  });

  it('sends rotate and waiting immediately without a flush', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    client.chunks.length = 0;
    hub.publish('rotate', { file: 'log_x.log' });
    expect(client.chunks.join('')).toContain('event: rotate');
    hub.close();
  });

  it('drops a client on close and stops writing to it', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const client = fakeRes();
    hub.addClient(client.res);
    expect(hub.clientCount).toBe(1);
    client.close();
    expect(hub.clientCount).toBe(0);
    client.chunks.length = 0;
    hub.publishEntries([entry(1)]);
    hub.flush();
    expect(client.chunks.join('')).toBe('');
    hub.close();
  });

  it('removes a client whose write throws', () => {
    const hub = new SseHub({ flushIntervalMs: 0 });
    const res = {
      write: () => { throw new Error('EPIPE'); },
      end: vi.fn(), on: vi.fn(), flushHeaders: vi.fn(), setHeader: vi.fn(),
    } as unknown as Response;
    hub.addClient(res);
    hub.publishEntries([entry(1)]);
    hub.flush();
    expect(hub.clientCount).toBe(0);
    hub.close();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/sseHub.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/sseHub.ts`**

```ts
import type { Response } from 'express';
import type { LogEntry, Stats } from '../shared/types.js';

export interface SseHubOptions {
  flushIntervalMs?: number;
  maxBatch?: number;
  heartbeatMs?: number;
}

export class SseHub {
  private readonly clients = new Set<Response>();
  private pendingEntries: LogEntry[] = [];
  private pendingStats: Stats | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly maxBatch: number;

  constructor(opts: SseHubOptions = {}) {
    this.maxBatch = opts.maxBatch ?? 500;
    const flushIntervalMs = opts.flushIntervalMs ?? 100;
    const heartbeatMs = opts.heartbeatMs ?? 20_000;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
      this.flushTimer.unref?.();
    }
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.writeAll(': heartbeat\n\n'), heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  addClient(res: Response): () => void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    this.clients.add(res);
    const detach = () => { this.clients.delete(res); };
    res.on('close', detach);
    return detach;
  }

  publishEntries(entries: LogEntry[]): void {
    if (entries.length > 0) this.pendingEntries.push(...entries);
  }

  publishStats(stats: Stats): void { this.pendingStats = stats; }

  publish(event: 'rotate' | 'waiting' | 'resnapshot', data: unknown): void {
    this.writeAll(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  flush(): void {
    if (this.pendingEntries.length > 0) {
      const batch = this.pendingEntries.length > this.maxBatch
        ? this.pendingEntries.slice(this.pendingEntries.length - this.maxBatch)
        : this.pendingEntries;
      this.pendingEntries = [];
      const lastSeq = batch[batch.length - 1]!.seq;
      this.writeAll(`event: entries\nid: ${lastSeq}\ndata: ${JSON.stringify(batch)}\n\n`);
    }
    if (this.pendingStats) {
      this.writeAll(`event: stats\ndata: ${JSON.stringify(this.pendingStats)}\n\n`);
      this.pendingStats = null;
    }
  }

  get clientCount(): number { return this.clients.size; }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) { try { client.end(); } catch { /* already gone */ } }
    this.clients.clear();
  }

  private writeAll(payload: string): void {
    for (const client of [...this.clients]) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/sseHub.test.ts` → PASS (6 tests).

- [ ] **Step 5: Implement `src/server/pipeline.ts`**

No separate unit test — Task 10's integration test covers it end to end.

```ts
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
    const { watcher, parser, buffer, stats, hub } = this.deps;

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
    void buffer;
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
```

The parser's `fallbackDate` is supplied at construction in `index.ts` and derived from the watcher's active file name; see Task 9 Step 5.

- [ ] **Step 6: Verify types**

Run: `npm run typecheck` → no errors. No commit.

---

### Task 9: Express app, routes, and entry point

**Files:**
- Create: `src/server/routes/auth.ts`, `src/server/routes/logs.ts`, `src/server/app.ts`, `src/server/index.ts`
- Test: `tests/unit/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `createApp(deps: AppDeps): Express` where

```ts
interface AppDeps {
  config: Config;
  jellyfin: JellyfinClient;
  buffer: EntryBuffer;
  stats: StatsEngine;
  hub: SseHub;
  pipeline: Pick<Pipeline, 'source'>;
  lockout?: LockoutTracker;
  clientDir?: string | null;   // null in tests: skip static hosting
}
```

- [ ] **Step 1: Write the failing routes test**

`tests/unit/routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import { StatsEngine } from '../../src/server/statsEngine.js';
import { SseHub } from '../../src/server/sseHub.js';
import { JellyfinAuthError, JellyfinUnreachableError } from '../../src/server/jellyfinClient.js';
import { LockoutTracker } from '../../src/server/sessionAuth.js';

const config = {
  jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'K', sessionSecret: 'secret',
  logDir: '/logs', port: 3000, bufferSize: 100, pollIntervalMs: 10,
  rescanIntervalMs: 10, startupTailBytes: 1024, maxTraceLines: 500, trustProxy: false,
};

const makeJellyfin = (overrides: Record<string, unknown> = {}) => ({
  listUsers: vi.fn(async () => [{ id: '1', name: 'james', hasAvatar: true }]),
  authenticate: vi.fn(async () => ({ userId: '1', name: 'james', token: 'tok' })),
  revoke: vi.fn(async () => undefined),
  fetchAvatar: vi.fn(async () => ({ body: Buffer.from([1]), contentType: 'image/png' })),
  ...overrides,
});

let buffer: EntryBuffer;
let hub: SseHub;
const build = (jellyfin = makeJellyfin(), lockout = new LockoutTracker()) => {
  buffer = new EntryBuffer(100);
  hub = new SseHub({ flushIntervalMs: 0, heartbeatMs: 0 });
  return createApp({
    config: config as never,
    jellyfin: jellyfin as never,
    buffer,
    stats: new StatsEngine(),
    hub,
    pipeline: { source: () => ({ file: 'log_a.log', waiting: false }) },
    lockout,
    clientDir: null,
  });
};

const login = async (app: ReturnType<typeof build>) => {
  const res = await request(app).post('/api/login').send({ username: 'james', password: 'pw' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'] as unknown as string[];
};

beforeEach(() => { hub?.close(); });

describe('routes', () => {
  it('serves health without auth', async () => {
    const res = await request(build()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('lists users without auth', async () => {
    const res = await request(build()).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: '1', name: 'james', hasAvatar: true }]);
  });

  it('reports an unauthenticated session', async () => {
    const res = await request(build()).get('/api/session');
    expect(res.body).toEqual({ authenticated: false, username: null });
  });

  it('rejects the snapshot and stream without a session', async () => {
    const app = build();
    expect((await request(app).get('/api/snapshot')).status).toBe(401);
    expect((await request(app).get('/api/stream')).status).toBe(401);
  });

  it('logs in, revokes the Jellyfin token, and exposes the session', async () => {
    const jellyfin = makeJellyfin();
    const app = build(jellyfin);
    const cookie = await login(app);
    expect(jellyfin.revoke).toHaveBeenCalledWith('tok');
    const res = await request(app).get('/api/session').set('Cookie', cookie);
    expect(res.body).toEqual({ authenticated: true, username: 'james' });
  });

  it('returns 401 with a wrong-password code', async () => {
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinAuthError('nope'); }),
    });
    const res = await request(build(jellyfin)).post('/api/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_credentials' });
  });

  it('returns 503 when Jellyfin is unreachable and consumes no lockout attempt', async () => {
    const lockout = new LockoutTracker();
    const spy = vi.spyOn(lockout, 'recordFailure');
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinUnreachableError('down'); }),
    });
    const res = await request(build(jellyfin, lockout)).post('/api/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'jellyfin_unreachable' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 429 once the lockout threshold is reached', async () => {
    const lockout = new LockoutTracker({ maxAttempts: 2 });
    const jellyfin = makeJellyfin({
      authenticate: vi.fn(async () => { throw new JellyfinAuthError('nope'); }),
    });
    const app = build(jellyfin, lockout);
    await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    const res = await request(app).post('/api/login').send({ username: 'a', password: 'b' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('locked_out');
  });

  it('rejects a login with a missing field', async () => {
    const res = await request(build()).post('/api/login').send({ username: 'a' });
    expect(res.status).toBe(400);
  });

  it('returns the snapshot with entries, stats and source once authenticated', async () => {
    const app = build();
    const cookie = await login(app);
    buffer.add({ ts: null, level: 'error', thread: null, component: 'A.B', message: 'boom', trace: ['x'], traceTruncated: false });
    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ seq: 1, level: 'error', message: 'boom' });
    expect(res.body.source).toEqual({ file: 'log_a.log', waiting: false });
    expect(res.body.lastSeq).toBe(1);
    expect(res.body.stats.windowMinutes).toBe(15);
  });

  it('honours the snapshot limit parameter', async () => {
    const app = build();
    const cookie = await login(app);
    for (let i = 0; i < 5; i++) {
      buffer.add({ ts: null, level: 'info', thread: null, component: 'A', message: `m${i}`, trace: [], traceTruncated: false });
    }
    const res = await request(app).get('/api/snapshot?limit=2').set('Cookie', cookie);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[1].message).toBe('m4');
  });

  it('logs out and invalidates the cookie', async () => {
    const app = build();
    const cookie = await login(app);
    await request(app).post('/api/logout').set('Cookie', cookie).expect(200);
    const stale = await request(app).get('/api/session');
    expect(stale.body.authenticated).toBe(false);
  });

  it('returns 404 for a missing avatar', async () => {
    const jellyfin = makeJellyfin({ fetchAvatar: vi.fn(async () => null) });
    const res = await request(build(jellyfin)).get('/api/users/1/avatar');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/routes.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/server/routes/auth.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import { JellyfinAuthError, JellyfinUnreachableError, type JellyfinClient } from '../jellyfinClient.js';
import {
  LockoutTracker, clearSession, clientIp, readSession, writeSession,
} from '../sessionAuth.js';

export function authRoutes(deps: {
  config: Config;
  jellyfin: JellyfinClient;
  lockout: LockoutTracker;
}): Router {
  const router = Router();
  const { config, jellyfin, lockout } = deps;

  router.get('/session', (req: Request, res: Response) => {
    const session = readSession(req);
    res.json({ authenticated: Boolean(session), username: session?.username ?? null });
  });

  router.get('/users', async (_req: Request, res: Response) => {
    try {
      res.json(await jellyfin.listUsers());
    } catch {
      res.status(503).json({ error: 'jellyfin_unreachable' });
    }
  });

  router.get('/users/:id/avatar', async (req: Request, res: Response) => {
    const avatar = await jellyfin.fetchAvatar(req.params.id!).catch(() => null);
    if (!avatar) { res.status(404).end(); return; }
    res.setHeader('Content-Type', avatar.contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(avatar.body);
  });

  router.post('/login', async (req: Request, res: Response) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: 'missing_credentials' });
      return;
    }
    const ip = clientIp(req, config.trustProxy);
    if (lockout.isBlocked(ip)) {
      res.status(429).json({ error: 'locked_out', retryAfterMs: lockout.retryAfterMs(ip) });
      return;
    }
    try {
      const result = await jellyfin.authenticate(username, password);
      await jellyfin.revoke(result.token);
      lockout.reset(ip);
      writeSession(res, { username: result.name, userId: result.userId, issuedAt: Date.now() }, config.trustProxy);
      res.json({ authenticated: true, username: result.name });
    } catch (error) {
      if (error instanceof JellyfinUnreachableError) {
        res.status(503).json({ error: 'jellyfin_unreachable' });
        return;
      }
      if (error instanceof JellyfinAuthError) {
        lockout.recordFailure(ip);
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      res.status(500).json({ error: 'login_failed' });
    }
  });

  router.post('/logout', (_req: Request, res: Response) => {
    clearSession(res);
    res.json({ authenticated: false, username: null });
  });

  return router;
}
```

- [ ] **Step 4: Implement `src/server/routes/logs.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import type { Snapshot } from '../../shared/types.js';
import type { EntryBuffer } from '../entryBuffer.js';
import type { Pipeline } from '../pipeline.js';
import { requireAuth } from '../sessionAuth.js';
import type { SseHub } from '../sseHub.js';
import type { StatsEngine } from '../statsEngine.js';

export function logRoutes(deps: {
  buffer: EntryBuffer;
  stats: StatsEngine;
  hub: SseHub;
  pipeline: Pick<Pipeline, 'source'>;
}): Router {
  const router = Router();
  const { buffer, stats, hub, pipeline } = deps;

  router.get('/snapshot', requireAuth, (req: Request, res: Response) => {
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) && raw > 0 ? raw : undefined;
    const snapshot: Snapshot = {
      entries: buffer.snapshot(limit),
      stats: stats.snapshot(),
      source: pipeline.source(),
      lastSeq: buffer.lastSeq,
    };
    res.json(snapshot);
  });

  router.get('/stream', requireAuth, (req: Request, res: Response) => {
    hub.addClient(res);
    const lastEventId = Number(req.headers['last-event-id']);
    if (Number.isInteger(lastEventId) && lastEventId > 0) {
      const missed = buffer.since(lastEventId);
      if (missed === null) {
        res.write('event: resnapshot\ndata: {}\n\n');
      } else if (missed.length > 0) {
        res.write(`event: entries\nid: ${missed[missed.length - 1]!.seq}\ndata: ${JSON.stringify(missed)}\n\n`);
      }
    }
    res.write(`event: stats\ndata: ${JSON.stringify(stats.snapshot())}\n\n`);
  });

  return router;
}
```

- [ ] **Step 5: Implement `src/server/app.ts` and `src/server/index.ts`**

```ts
// src/server/app.ts
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
```

```ts
// src/server/index.ts
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
  const jellyfin = new JellyfinClient({ baseUrl: config.jellyfinUrl, apiKey: config.jellyfinApiKey });

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
```

- [ ] **Step 6: Run the routes test and confirm it passes**

Run: `npx vitest run tests/unit/routes.test.ts` → PASS (14 tests).

- [ ] **Step 7: Verify the whole suite and types**

Run: `npm run typecheck && npx vitest run`
Expected: all unit tests pass. No commit.

---

### Task 10: Integration test — file to SSE

**Files:**
- Test: `tests/integration/stream.test.ts`

**Interfaces:**
- Consumes: everything; adds no production code. If this test reveals a wiring defect, fix the production module it belongs to.

- [ ] **Step 1: Write the integration test**

`tests/integration/stream.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { EntryBuffer } from '../../src/server/entryBuffer.js';
import { LineParser } from '../../src/server/logParser.js';
import { LogFileWatcher } from '../../src/server/logWatcher.js';
import { Pipeline } from '../../src/server/pipeline.js';
import { SseHub } from '../../src/server/sseHub.js';
import { StatsEngine } from '../../src/server/statsEngine.js';

const config = {
  jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'K', sessionSecret: 'secret',
  logDir: '', port: 0, bufferSize: 100, pollIntervalMs: 10, rescanIntervalMs: 10,
  startupTailBytes: 65536, maxTraceLines: 500, trustProxy: false,
};

const jellyfin = {
  listUsers: async () => [{ id: '1', name: 'james', hasAvatar: false }],
  authenticate: async () => ({ userId: '1', name: 'james', token: 'tok' }),
  revoke: async () => undefined,
  fetchAvatar: async () => null,
};

let dir = '';
let pipeline: Pipeline;
let hub: SseHub;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'logwatch-int-')); });
afterEach(async () => { pipeline?.stop(); hub?.close(); await rm(dir, { recursive: true, force: true }); });

const build = async () => {
  const watcher = new LogFileWatcher({ dir, pollIntervalMs: 10, rescanIntervalMs: 10, startupTailBytes: 65536 });
  const parser = new LineParser({ maxTraceLines: 500, fallbackDate: () => '2026-07-26' });
  const buffer = new EntryBuffer(100);
  const stats = new StatsEngine();
  hub = new SseHub({ flushIntervalMs: 10, heartbeatMs: 0 });
  pipeline = new Pipeline({ watcher, parser, buffer, stats, hub, statsIntervalMs: 10 });
  await pipeline.start();
  const app = createApp({ config: { ...config, logDir: dir } as never, jellyfin: jellyfin as never, buffer, stats, hub, pipeline, clientDir: null });
  return { app, watcher, buffer };
};

const settle = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)); };

const authCookie = async (app: Awaited<ReturnType<typeof build>>['app']) => {
  const res = await request(app).post('/api/login').send({ username: 'james', password: 'pw' });
  return res.headers['set-cookie'] as unknown as string[];
};

describe('file → SSE integration', () => {
  it('delivers appended lines to the snapshot in order, folding traces', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '');
    const { app } = await build();
    const cookie = await authCookie(app);

    await appendFile(join(dir, 'log_20260726.log'),
      '[2026-07-26 22:14:03.123 -05:00] [ERR] [42] A.B: boom\n' +
      '   at One()\n   at Two()\n' +
      '[2026-07-26 22:14:04.000 -05:00] [INF] [7] C.D: fine\n');
    await settle();

    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ level: 'error', message: 'boom' });
    expect(res.body.entries[0].trace).toEqual(['   at One()', '   at Two()']);
    expect(res.body.entries[1]).toMatchObject({ level: 'info', message: 'fine' });
    expect(res.body.source.waiting).toBe(false);
  });

  it('flushes a trailing entry on an idle poll', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '');
    const { app } = await build();
    const cookie = await authCookie(app);
    await appendFile(join(dir, 'log_20260726.log'), '[2026-07-26 22:15:00.000 -05:00] [WRN] [1] E.F: alone\n');
    await settle();
    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].message).toBe('alone');
  });

  it('continues across a rotation to a newer file', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '[2026-07-26 23:59:59.000 -05:00] [INF] [1] A: before\n');
    const { app } = await build();
    const cookie = await authCookie(app);
    await settle();

    const next = join(dir, 'log_20260727.log');
    await writeFile(next, '[2026-07-27 00:00:01.000 -05:00] [INF] [1] A: after\n');
    await utimes(next, new Date(), new Date(Date.now() + 60_000));
    await settle(200);

    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    const messages = res.body.entries.map((e: { message: string }) => e.message);
    expect(messages).toContain('before');
    expect(messages).toContain('after');
  });

  it('streams entries over SSE to a connected client', async () => {
    await writeFile(join(dir, 'log_20260726.log'), '');
    const { app } = await build();
    const cookie = await authCookie(app);

    const received: string[] = [];
    const req = request(app).get('/api/stream').set('Cookie', cookie).buffer(false);
    req.on('response', (res) => { res.on('data', (chunk: Buffer) => received.push(chunk.toString())); });
    void req.end(() => undefined);
    await settle();

    await appendFile(join(dir, 'log_20260726.log'), '[2026-07-26 22:20:00.000 -05:00] [ERR] [1] Z: streamed\n');
    await settle(200);

    const payload = received.join('');
    expect(payload).toContain('event: entries');
    expect(payload).toContain('streamed');
  });

  it('reports waiting when the directory has no log files', async () => {
    const { app } = await build();
    const cookie = await authCookie(app);
    const res = await request(app).get('/api/snapshot').set('Cookie', cookie);
    expect(res.body.source).toEqual({ file: null, waiting: true });
  });
});
```

- [ ] **Step 2: Run it and confirm it passes**

Run: `npx vitest run tests/integration/stream.test.ts` → PASS (5 tests).

If the rotation test is flaky, raise its `settle` value rather than weakening the assertion — the watcher's rescan interval is 10 ms here, so 200 ms is already ~20 cycles. No commit.

---

### Task 11: Client API layer, filters, and the log stream hook

**Files:**
- Create: `src/client/api.ts`, `src/client/filter.ts`, `src/client/useLogStream.ts`, `src/client/main.tsx`, `src/client/App.tsx`
- Test: `tests/unit/filter.test.ts`

**Interfaces:**
- Consumes: `src/shared/types.js`.
- Produces:

```ts
// api.ts
async function getSession(): Promise<SessionInfo>;
async function getUsers(): Promise<LoginUser[]>;
async function login(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string; retryAfterMs?: number }>;
async function logout(): Promise<void>;
async function getSnapshot(limit?: number): Promise<Snapshot>;

// filter.ts
interface Filters { levels: Set<Level>; component: string | null; search: string }
function applyFilters(entries: LogEntry[], filters: Filters): LogEntry[];
const ALL_LEVELS_ON: () => Set<Level>;

// useLogStream.ts
function useLogStream(enabled: boolean): {
  entries: LogEntry[];
  stats: Stats | null;
  source: SourceState;
  connected: boolean;
  rotations: number[];   // seq numbers a day divider precedes
};
```

- [ ] **Step 1: Write the failing filter test**

`tests/unit/filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyFilters, ALL_LEVELS_ON } from '../../src/client/filter.js';
import type { LogEntry, Level } from '../../src/shared/types.js';

let seq = 0;
const entry = (level: Level, component: string, message: string, trace: string[] = []): LogEntry => ({
  seq: ++seq, ts: null, level, thread: null, component, message, trace, traceTruncated: false,
});

const base = { levels: ALL_LEVELS_ON(), component: null, search: '' };

describe('applyFilters', () => {
  const entries = [
    entry('info', 'A.B', 'playback started'),
    entry('error', 'C.D', 'database is locked', ['   at Foo()']),
    entry('warn', 'A.B', 'slow response'),
  ];

  it('returns everything with default filters', () => {
    expect(applyFilters(entries, base)).toHaveLength(3);
  });

  it('filters by level', () => {
    const result = applyFilters(entries, { ...base, levels: new Set<Level>(['error']) });
    expect(result.map((e) => e.message)).toEqual(['database is locked']);
  });

  it('filters by component', () => {
    const result = applyFilters(entries, { ...base, component: 'A.B' });
    expect(result).toHaveLength(2);
  });

  it('searches message text case-insensitively', () => {
    expect(applyFilters(entries, { ...base, search: 'DATABASE' })).toHaveLength(1);
  });

  it('searches inside stack traces too', () => {
    expect(applyFilters(entries, { ...base, search: 'at Foo' })).toHaveLength(1);
  });

  it('searches the component name', () => {
    expect(applyFilters(entries, { ...base, search: 'C.D' })).toHaveLength(1);
  });

  it('combines filters with AND semantics', () => {
    const result = applyFilters(entries, { ...base, levels: new Set<Level>(['warn']), component: 'A.B' });
    expect(result.map((e) => e.message)).toEqual(['slow response']);
  });

  it('returns an empty array when no level is enabled', () => {
    expect(applyFilters(entries, { ...base, levels: new Set<Level>() })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/filter.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `src/client/filter.ts`**

```ts
import { LEVELS, type Level, type LogEntry } from '../shared/types.js';

export interface Filters {
  levels: Set<Level>;
  component: string | null;
  search: string;
}

export const ALL_LEVELS_ON = (): Set<Level> => new Set<Level>(LEVELS);

export function applyFilters(entries: LogEntry[], filters: Filters): LogEntry[] {
  const needle = filters.search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!filters.levels.has(entry.level)) return false;
    if (filters.component && entry.component !== filters.component) return false;
    if (!needle) return true;
    if (entry.message.toLowerCase().includes(needle)) return true;
    if (entry.component?.toLowerCase().includes(needle)) return true;
    return entry.trace.some((line) => line.toLowerCase().includes(needle));
  });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/filter.test.ts` → PASS (8 tests).

- [ ] **Step 5: Implement `src/client/api.ts`**

```ts
import type { LoginUser, SessionInfo, Snapshot } from '../shared/types.js';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`${input} → ${response.status}`);
  return (await response.json()) as T;
}

export const getSession = () => json<SessionInfo>('/api/session');
export const getUsers = () => json<LoginUser[]>('/api/users');
export const getSnapshot = (limit?: number) =>
  json<Snapshot>(`/api/snapshot${limit ? `?limit=${limit}` : ''}`);

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string; retryAfterMs?: number }> {
  const response = await fetch('/api/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => ({}))) as { error?: string; retryAfterMs?: number };
  return { ok: false, error: body.error ?? 'login_failed', retryAfterMs: body.retryAfterMs };
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
}
```

- [ ] **Step 6: Implement `src/client/useLogStream.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry, SourceState, Stats } from '../shared/types.js';
import { getSnapshot } from './api.js';

const MAX_CLIENT_ENTRIES = 5000;

export function useLogStream(enabled: boolean) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [source, setSource] = useState<SourceState>({ file: null, waiting: true });
  const [connected, setConnected] = useState(false);
  const [rotations, setRotations] = useState<number[]>([]);
  const lastSeq = useRef(0);

  const resnapshot = useCallback(async () => {
    const snapshot = await getSnapshot();
    setEntries(snapshot.entries);
    setStats(snapshot.stats);
    setSource(snapshot.source);
    lastSeq.current = snapshot.lastSeq;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void resnapshot().catch(() => undefined);

    const stream = new EventSource('/api/stream', { withCredentials: true });
    stream.onopen = () => { if (!cancelled) setConnected(true); };
    stream.onerror = () => { if (!cancelled) setConnected(false); };

    stream.addEventListener('entries', (event) => {
      const incoming = JSON.parse((event as MessageEvent<string>).data) as LogEntry[];
      if (incoming.length === 0) return;
      lastSeq.current = incoming[incoming.length - 1]!.seq;
      setEntries((previous) => {
        const next = [...previous, ...incoming];
        return next.length > MAX_CLIENT_ENTRIES ? next.slice(next.length - MAX_CLIENT_ENTRIES) : next;
      });
    });

    stream.addEventListener('stats', (event) => {
      setStats(JSON.parse((event as MessageEvent<string>).data) as Stats);
    });

    stream.addEventListener('rotate', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { file: string };
      setSource((previous) => ({ ...previous, file: data.file, waiting: false }));
      setRotations((previous) => [...previous, lastSeq.current + 1]);
    });

    stream.addEventListener('waiting', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { waiting: boolean };
      setSource((previous) => ({ ...previous, waiting: data.waiting }));
    });

    stream.addEventListener('resnapshot', () => { void resnapshot().catch(() => undefined); });

    return () => { cancelled = true; stream.close(); };
  }, [enabled, resnapshot]);

  return { entries, stats, source, connected, rotations };
}
```

- [ ] **Step 7: Implement `src/client/main.tsx` and a minimal `src/client/App.tsx`**

```tsx
// src/client/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

```tsx
// src/client/App.tsx
import { useCallback, useEffect, useState } from 'react';
import { getSession, logout as apiLogout } from './api.js';
import { Login } from './components/Login.js';
import { Dashboard } from './components/Dashboard.js';

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void getSession()
      .then((session) => setUsername(session.username))
      .catch(() => setUsername(null))
      .finally(() => setReady(true));
  }, []);

  const handleLogout = useCallback(async () => {
    await apiLogout();
    setUsername(null);
  }, []);

  if (!ready) return <div className="boot">Connecting…</div>;
  if (!username) return <Login onAuthenticated={setUsername} />;
  return <Dashboard username={username} onLogout={handleLogout} />;
}
```

Create an empty `src/client/styles.css` for now; Task 15 fills it in.

- [ ] **Step 8: Verify**

Run: `npx vitest run tests/unit/filter.test.ts` → PASS. Typecheck will still fail until Tasks 12–14 create `Login` and `Dashboard`; that is expected at this point. No commit.

---

### Task 12: Login screen

**Files:**
- Create: `src/client/components/Login.tsx`

**Interfaces:**
- Consumes: `getUsers`, `login` from `src/client/api.js`; `LoginUser` from types.
- Produces: `function Login(props: { onAuthenticated: (username: string) => void }): JSX.Element`.

- [ ] **Step 1: Implement the component**

```tsx
import { useEffect, useState } from 'react';
import type { LoginUser } from '../../shared/types.js';
import { getUsers, login } from '../api.js';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong password.',
  jellyfin_unreachable: 'Jellyfin is unreachable — nobody can log in until it is back.',
  locked_out: 'Too many failed attempts. Try again later.',
  missing_credentials: 'Enter a password.',
  login_failed: 'Login failed.',
};

export function Login({ onAuthenticated }: { onAuthenticated: (username: string) => void }) {
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [selected, setSelected] = useState<LoginUser | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState(false);

  useEffect(() => {
    void getUsers().then(setUsers).catch(() => setListError(true));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const result = await login(selected.name, password);
    setBusy(false);
    if (result.ok) { onAuthenticated(selected.name); return; }
    setPassword('');
    setError(MESSAGES[result.error] ?? MESSAGES.login_failed!);
  };

  return (
    <div className="login">
      <h1 className="login__title">Jellyfin Logwatch</h1>
      {listError && <p className="login__error">Could not reach Jellyfin to load the user list.</p>}
      {!selected ? (
        <ul className="login__users">
          {users.map((user) => (
            <li key={user.id}>
              <button type="button" className="login__user" onClick={() => setSelected(user)}>
                {user.hasAvatar
                  ? <img className="login__avatar" src={`/api/users/${user.id}/avatar`} alt="" />
                  : <span className="login__avatar login__avatar--initial">{user.name.slice(0, 1).toUpperCase()}</span>}
                <span className="login__name">{user.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form className="login__form" onSubmit={submit}>
          <p className="login__selected">{selected.name}</p>
          <input
            className="login__password"
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="login__actions">
            <button type="button" onClick={() => { setSelected(null); setError(null); setPassword(''); }}>
              Back
            </button>
            <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </div>
          {error && <p className="login__error" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
```

All user-supplied text here is rendered as JSX children, which React escapes — no `innerHTML` anywhere.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: only errors about the not-yet-created `Dashboard`. No commit.

---

### Task 13: StatsStrip and Sparkline

**Files:**
- Create: `src/client/components/Sparkline.tsx`, `src/client/components/StatsStrip.tsx`

**Interfaces:**
- Produces:
  - `function Sparkline(props: { values: number[]; width?: number; height?: number }): JSX.Element`
  - `function StatsStrip(props: { stats: Stats | null; source: SourceState; connected: boolean }): JSX.Element`

- [ ] **Step 1: Implement `Sparkline.tsx`**

```tsx
export function Sparkline({ values, width = 120, height = 28 }: {
  values: number[]; width?: number; height?: number;
}) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         role="img" aria-label={`Log volume, peak ${max} per minute`}>
      <polyline className="sparkline__line" points={points} fill="none" />
    </svg>
  );
}
```

- [ ] **Step 2: Implement `StatsStrip.tsx`**

```tsx
import { LEVELS, type Level, type SourceState, type Stats } from '../../shared/types.js';
import { Sparkline } from './Sparkline.js';

const SHOWN: Level[] = ['fatal', 'error', 'warn', 'info', 'debug'];

export function StatsStrip({ stats, source, connected }: {
  stats: Stats | null; source: SourceState; connected: boolean;
}) {
  return (
    <header className="stats">
      <div className="stats__counts">
        {SHOWN.map((level) => (
          <div key={level} className={`stats__count stats__count--${level}`}>
            <span className="stats__value">{stats?.counts[level] ?? 0}</span>
            <span className="stats__label">{level}</span>
          </div>
        ))}
      </div>

      <div className="stats__volume">
        <Sparkline values={stats?.sparkline ?? Array<number>(15).fill(0)} />
        <span className="stats__window">last {stats?.windowMinutes ?? 15} min · {stats?.linesPerSecond ?? 0}/s</span>
      </div>

      <ul className="stats__components">
        {(stats?.topComponents ?? []).map((item) => (
          <li key={item.component} className="stats__component">
            <span className="stats__component-name">{shortComponent(item.component)}</span>
            <span className="stats__component-count">{item.count}</span>
          </li>
        ))}
      </ul>

      <div className="stats__source">
        <span className={`stats__dot ${connected ? 'stats__dot--live' : 'stats__dot--down'}`} />
        <span>{source.waiting ? 'waiting for log file' : source.file ?? '—'}</span>
      </div>
    </header>
  );
}

function shortComponent(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] ?? name;
}

void LEVELS;
```

Remove the trailing `void LEVELS;` if the import is unnecessary — it is present only to keep the example self-consistent; prefer deleting the unused import instead.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit` (Dashboard errors still expected). No commit.

---

### Task 14: FilterBar, Feed, EntryRow, Dashboard

**Files:**
- Create: `src/client/components/FilterBar.tsx`, `src/client/components/EntryRow.tsx`, `src/client/components/Feed.tsx`, `src/client/components/Dashboard.tsx`

**Interfaces:**
- Produces:
  - `function FilterBar(props: { filters: Filters; onChange: (next: Filters) => void; following: boolean; onToggleFollow: () => void; components: string[] }): JSX.Element`
  - `function EntryRow(props: { entry: LogEntry; onSelectComponent: (component: string) => void }): JSX.Element`
  - `function Feed(props: { entries: LogEntry[]; rotations: number[]; following: boolean; onFollowChange: (following: boolean) => void; onSelectComponent: (component: string) => void }): JSX.Element`
  - `function Dashboard(props: { username: string; onLogout: () => void }): JSX.Element`

- [ ] **Step 1: Implement `FilterBar.tsx`**

```tsx
import { LEVELS, type Level } from '../../shared/types.js';
import type { Filters } from '../filter.js';

export function FilterBar({ filters, onChange, following, onToggleFollow, components }: {
  filters: Filters;
  onChange: (next: Filters) => void;
  following: boolean;
  onToggleFollow: () => void;
  components: string[];
}) {
  const toggleLevel = (level: Level) => {
    const levels = new Set(filters.levels);
    if (levels.has(level)) levels.delete(level); else levels.add(level);
    onChange({ ...filters, levels });
  };

  const errorsOnly = () => onChange({ ...filters, levels: new Set<Level>(['error', 'fatal']) });
  const allLevels = () => onChange({ ...filters, levels: new Set<Level>(LEVELS) });

  return (
    <div className="filters">
      <div className="filters__levels">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={filters.levels.has(level)}
            className={`filters__level filters__level--${level} ${filters.levels.has(level) ? 'is-on' : ''}`}
            onClick={() => toggleLevel(level)}
          >
            {level}
          </button>
        ))}
        <button type="button" className="filters__preset" onClick={errorsOnly}>errors only</button>
        <button type="button" className="filters__preset" onClick={allLevels}>all</button>
      </div>

      <select
        className="filters__component"
        value={filters.component ?? ''}
        onChange={(event) => onChange({ ...filters, component: event.target.value || null })}
      >
        <option value="">all components</option>
        {components.map((component) => <option key={component} value={component}>{component}</option>)}
      </select>

      <input
        className="filters__search"
        type="search"
        placeholder="Search messages and traces…"
        value={filters.search}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
      />

      <button
        type="button"
        className={`filters__follow ${following ? 'is-on' : ''}`}
        aria-pressed={following}
        onClick={onToggleFollow}
      >
        {following ? 'following' : 'paused'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Implement `EntryRow.tsx`**

```tsx
import { useState } from 'react';
import type { LogEntry } from '../../shared/types.js';

const time = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) : '--:--:--';

export function EntryRow({ entry, onSelectComponent }: {
  entry: LogEntry;
  onSelectComponent: (component: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`entry entry--${entry.level}`} data-testid="entry">
      <div className="entry__head">
        <span className={`entry__level entry__level--${entry.level}`}>{entry.level}</span>
        <time className="entry__time">{time(entry.ts)}</time>
        {entry.component && (
          <button type="button" className="entry__component" onClick={() => onSelectComponent(entry.component!)}>
            {entry.component}
          </button>
        )}
        <span className="entry__message">{entry.message}</span>
      </div>

      {entry.trace.length > 0 && (
        <>
          <button
            type="button"
            className="entry__toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '▾ hide' : `▸ ${entry.trace.length} more lines`}
            {entry.traceTruncated && ' (truncated)'}
          </button>
          {open && <pre className="entry__trace">{entry.trace.join('\n')}</pre>}
        </>
      )}
    </article>
  );
}
```

`{entry.message}` and `{entry.trace.join('\n')}` are JSX children — React escapes them. This is the XSS guarantee Task 18 probes.

- [ ] **Step 3: Implement `Feed.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogEntry } from '../../shared/types.js';
import { EntryRow } from './EntryRow.js';

const AT_BOTTOM_PX = 40;

export function Feed({ entries, rotations, following, onFollowChange, onSelectComponent }: {
  entries: LogEntry[];
  rotations: number[];
  following: boolean;
  onFollowChange: (following: boolean) => void;
  onSelectComponent: (component: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rotationSet = new Set(rotations);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  useEffect(() => {
    if (!following || entries.length === 0) return;
    virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
  }, [entries.length, following, virtualizer]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < AT_BOTTOM_PX;
    if (atBottom !== following) onFollowChange(atBottom);
  };

  return (
    <div className="feed" ref={scrollRef} onScroll={handleScroll} data-testid="feed">
      <div className="feed__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = entries[item.index]!;
          return (
            <div
              key={entry.seq}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="feed__row"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {rotationSet.has(entry.seq) && <div className="feed__divider">new log file</div>}
              <EntryRow entry={entry} onSelectComponent={onSelectComponent} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `Dashboard.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { ALL_LEVELS_ON, applyFilters, type Filters } from '../filter.js';
import { useLogStream } from '../useLogStream.js';
import { FilterBar } from './FilterBar.js';
import { Feed } from './Feed.js';
import { StatsStrip } from './StatsStrip.js';

export function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  const { entries, stats, source, connected, rotations } = useLogStream(true);
  const [filters, setFilters] = useState<Filters>({ levels: ALL_LEVELS_ON(), component: null, search: '' });
  const [following, setFollowing] = useState(true);

  const visible = useMemo(() => applyFilters(entries, filters), [entries, filters]);
  const components = useMemo(
    () => [...new Set(entries.map((entry) => entry.component).filter((c): c is string => Boolean(c)))].sort(),
    [entries],
  );
  const hidden = entries.length - visible.length;

  return (
    <div className="dashboard">
      <StatsStrip stats={stats} source={source} connected={connected} />
      <FilterBar
        filters={filters}
        onChange={setFilters}
        following={following}
        onToggleFollow={() => setFollowing((value) => !value)}
        components={components}
      />
      {source.waiting && <p className="dashboard__waiting">No log file found in the mounted directory yet.</p>}
      <Feed
        entries={visible}
        rotations={rotations}
        following={following}
        onFollowChange={setFollowing}
        onSelectComponent={(component) => setFilters((f) => ({ ...f, component }))}
      />
      <footer className="dashboard__footer">
        <span>{visible.length} shown{hidden > 0 ? ` · ${hidden} filtered out` : ''}</span>
        <span className="dashboard__user">{username}</span>
        <button type="button" onClick={onLogout}>Sign out</button>
      </footer>
    </div>
  );
}
```

- [ ] **Step 5: Verify the client compiles and builds**

Run: `npm run typecheck && npm run build:client`
Expected: both succeed. No commit.

---

### Task 15: Visual design pass

**Files:**
- Modify: `src/client/styles.css` (and component class names only where the design requires it)

**Interfaces:**
- Consumes: the components from Tasks 12–14 and their existing class names.
- Produces: no new exports. Component *props* must not change — Task 18's e2e selectors depend on `data-testid="feed"`, `data-testid="entry"`, and the `aria-pressed` buttons.

- [ ] **Step 1: Invoke the frontend-design skill**

Invoke `frontend-design:frontend-design` and follow it to choose a deliberate visual direction for a dense, dark, always-on log console. Do not settle for a default dashboard look.

- [ ] **Step 2: Write `src/client/styles.css` implementing that direction**

Requirements the design must satisfy, regardless of aesthetic choice:

- Dark by default — this runs on a wall display and next to Jellyfin's own dark UI.
- The five level colours must be distinguishable **and** each level must also carry a non-colour cue (the text label already present), so the feed is readable for colour-blind users.
- Monospace for log text; the message column must not reflow jarringly as entries arrive.
- The stats strip must stay legible at a glance from across a room: large numerals for the error and warning counts.
- Rows must not shift when a neighbour's trace expands — expansion grows downward only.
- Respect `prefers-reduced-motion`: no animated transitions on the feed when it is set.

- [ ] **Step 3: Verify visually**

Run: `npm run build:client` then serve `dist/client` and screenshot the dashboard against fixture data. Confirm the six requirements above. No commit.

---

### Task 16: Docker packaging

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`

**Interfaces:**
- Consumes: `npm run build`, `npm start`, `/api/health`.
- Produces: an image whose entry point is `node dist/server/server/index.js`.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
.git
tests
docs
.env
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
```

The `dist/server/server/index.js` path is correct: `tsconfig.server.json` sets `outDir: dist/server` and `rootDir: src`, so `src/server/index.ts` compiles to `dist/server/server/index.js`. Verify this in Step 5 rather than assuming.

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  jellyfin-logwatch:
    image: ghcr.io/atvriders/jellyfin-logwatch:latest
    container_name: jellyfin-logwatch
    ports:
      - "5460:3000"
    environment:
      # Your Jellyfin server. Include the port unless it is behind a reverse proxy.
      - JELLYFIN_URL=http://your-jellyfin-host:8096
      # Jellyfin Dashboard > Advanced > API Keys > + New Key.
      # Used ONLY to list users on the login screen — passwords are checked by Jellyfin.
      - JELLYFIN_API_KEY=your_api_key_here
      # Long random string. Changing it signs everyone out.
      - SESSION_SECRET=change_this_to_a_long_random_string
      # Uncomment behind nginx / Traefik / Cloudflare Tunnel so lockout sees real client IPs.
      # - TRUST_PROXY=1
    volumes:
      # REQUIRED and read-only: Jellyfin's log directory on the host.
      # Nothing is persisted by this container — there is no data volume by design.
      - /path/to/jellyfin/log:/logs:ro
    restart: unless-stopped
```

- [ ] **Step 4: Write `.env.example`**

```bash
# Jellyfin server URL (include the port unless behind a reverse proxy)
JELLYFIN_URL=http://your-jellyfin-host:8096

# Jellyfin API key — Dashboard > Advanced > API Keys.
# Used only to list users for the login screen; passwords are verified by Jellyfin itself.
JELLYFIN_API_KEY=your_api_key_here

# Session cookie signing key — long random string
SESSION_SECRET=change_this_to_a_long_random_string

# Directory the Jellyfin log files are mounted at (read-only)
LOG_DIR=/logs

# Optional tuning
# PORT=3000
# BUFFER_SIZE=5000
# POLL_INTERVAL_MS=750
# RESCAN_INTERVAL_MS=5000
# STARTUP_TAIL_BYTES=262144
# MAX_TRACE_LINES=500

# Set to 1 only when behind a reverse proxy that sets X-Forwarded-For
# TRUST_PROXY=1
```

- [ ] **Step 5: Verify the build output path locally**

Run: `npm run build && ls dist/server/server/index.js && node -e "process.env.JELLYFIN_URL='http://x';process.env.JELLYFIN_API_KEY='k';process.env.SESSION_SECRET='s';process.env.LOG_DIR='/tmp';import('./dist/server/server/index.js')"`
Expected: the file exists and the server logs `[logwatch] listening on :3000`. Kill it with Ctrl-C.

If the path differs, fix the `Dockerfile` `CMD` and the `start` script to match reality. No commit.

---

### Task 17: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`.
- Produces: `ghcr.io/atvriders/jellyfin-logwatch:latest` and `:${{ github.sha }}`, public, multi-arch.

- [ ] **Step 1: Write the workflow**

```yaml
name: CI

on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e

  image:
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/atvriders/jellyfin-logwatch:latest
            ghcr.io/atvriders/jellyfin-logwatch:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Verify the YAML parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!y.includes('linux/arm64')) throw new Error('missing arm64'); console.log('ok')"`

Note for the owner: after the first successful `image` run, set the GHCR package visibility to **public** in the repo's package settings. On a brand-new repo the push-triggered build may need one manual `workflow_dispatch` first. No commit.

---

### Task 18: Playwright end-to-end tests

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/mockJellyfin.ts`, `tests/e2e/logwatch.spec.ts`

**Interfaces:**
- Consumes: the built client (`dist/client`) and the real server, pointed at a temp log directory and a mock Jellyfin.
- Produces: nothing importable.

- [ ] **Step 1: Write the mock Jellyfin server**

`tests/e2e/mockJellyfin.ts`:

```ts
import { createServer, type Server } from 'node:http';

export function startMockJellyfin(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/Users/AuthenticateByName')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { Username, Pw } = JSON.parse(body || '{}') as { Username?: string; Pw?: string };
        if (Pw === 'correct-horse') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ AccessToken: 'tok', User: { Id: '1', Name: Username } }));
        } else {
          res.writeHead(401).end();
        }
      });
      return;
    }
    if (url === '/Users') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ Id: '1', Name: 'james', Policy: { IsDisabled: false } }]));
      return;
    }
    if (url === '/Sessions/Logout') { res.writeHead(204).end(); return; }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
```

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3999', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: 'http://127.0.0.1:3999/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
```

Create `tests/e2e/server.mjs` alongside it: it starts `startMockJellyfin(3998)`, creates a temp log directory, writes its path to `tests/e2e/.logdir`, and then boots the real server with `JELLYFIN_URL=http://127.0.0.1:3998`, `JELLYFIN_API_KEY=k`, `SESSION_SECRET=e2e`, `LOG_DIR=<temp>`, `PORT=3999`, `POLL_INTERVAL_MS=100`, `RESCAN_INTERVAL_MS=100`, importing `dist/server/server/index.js`. Tests read `.logdir` to append lines. The suite therefore requires `npm run build` first — the CI workflow already runs it before `test:e2e`.

- [ ] **Step 3: Write `tests/e2e/logwatch.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const logDir = async () => (await readFile('tests/e2e/.logdir', 'utf8')).trim();
const append = async (text: string) => appendFile(join(await logDir(), 'log_20260726.log'), text);
const stamp = (level: string, component: string, message: string) =>
  `[2026-07-26 22:14:03.123 -05:00] [${level}] [42] ${component}: ${message}\n`;

test('rejects a wrong password and accepts the right one', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'james' }).click();
  await page.getByPlaceholder('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong password');

  await page.getByPlaceholder('Password').fill('correct-horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('feed')).toBeVisible();
});

test('streams new entries, folds traces, and filters to errors', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'james' }).click();
  await page.getByPlaceholder('Password').fill('correct-horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('feed')).toBeVisible();

  await append(stamp('INF', 'Session.Manager', 'playback started'));
  await append(stamp('ERR', 'Db.Context', 'database is locked') + '   at One()\n   at Two()\n');
  await append(stamp('INF', 'Session.Manager', 'playback stopped'));

  await expect(page.getByText('database is locked')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '▸ 2 more lines' })).toBeVisible();

  await page.getByRole('button', { name: '▸ 2 more lines' }).click();
  await expect(page.getByText('at One()')).toBeVisible();

  await page.getByRole('button', { name: 'errors only' }).click();
  await expect(page.getByText('playback started')).toHaveCount(0);
  await expect(page.getByText('database is locked')).toBeVisible();
});

test('renders injected markup inert', async ({ page }) => {
  const alerts: string[] = [];
  page.on('dialog', async (dialog) => { alerts.push(dialog.message()); await dialog.dismiss(); });

  await page.goto('/');
  await page.getByRole('button', { name: 'james' }).click();
  await page.getByPlaceholder('Password').fill('correct-horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('feed')).toBeVisible();

  await append(stamp('WRN', 'Http.Server', '<img src=x onerror="alert(1)"> <script>alert(2)</script>'));
  await expect(page.getByText('<img src=x onerror=')).toBeVisible({ timeout: 10_000 });
  expect(alerts).toHaveLength(0);
  expect(await page.locator('[data-testid="entry"] img').count()).toBe(0);
});

test('pauses following when scrolled up', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'james' }).click();
  await page.getByPlaceholder('Password').fill('correct-horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('feed')).toBeVisible();

  for (let i = 0; i < 120; i++) await append(stamp('INF', 'Bulk.Filler', `line ${i}`));
  await expect(page.getByText('line 119')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('feed').evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: 'paused' })).toBeVisible();
});
```

- [ ] **Step 4: Run the e2e suite**

Run: `npm run build && npx playwright install chromium && npm run test:e2e`
Expected: 4 passing tests. Fix production code — not the assertions — if anything fails. No commit.

---

### Task 19: README, full verification, single commit, publish

**Files:**
- Create: `README.md`
- Modify: `.gitignore` (add `tests/e2e/.logdir`, `playwright-report`, `test-results`)

- [ ] **Step 1: Write `README.md`**

Cover, in this order: what it does (with a one-line statement that it is read-only and stores nothing), a screenshot placeholder, quick start with the compose block from Task 16, how to create the Jellyfin API key, the full environment variable table from the spec's §10, how login works (any Jellyfin user, password verified by Jellyfin, token revoked immediately), the "no database / today's log only" scope statement, and a troubleshooting section covering: no log file found (wrong mount path), feed not updating (confirm the mount is the directory not a single file), and login failing for everyone (Jellyfin unreachable).

- [ ] **Step 2: Run the complete verification**

Run each and confirm each passes before continuing:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Do not proceed past a failure. Per `superpowers:verification-before-completion`, paste the real output; do not assert success without it.

- [ ] **Step 3: Make the single commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Add Jellyfin Logwatch: live parsed log dashboard for Unraid

Tails Jellyfin's current log file from a read-only bind mount using byte-offset
polling (inotify is unreliable on Unraid's FUSE /mnt/user), parses the Serilog
file template into structured entries that fold multi-line stack traces into a
single row, keeps a 5,000-entry in-memory ring with a 15-minute rolling stats
window, and streams it to a React dashboard over SSE.

Login accepts any Jellyfin account: the API key lists users for the login
screen, Jellyfin itself verifies the password, and the returned token is
revoked immediately. No database, no writable volume, no outbound calls.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Create the public GitHub repo and push**

Use `curl` against the GitHub API with the `gho_` token from `~/.config/gh/hosts.yml` (not the `gh` CLI, and not `~/.github_token`). Create `Atvriders/jellyfin-logwatch` with `"private": false`, add it as `origin`, and push `master`.

- [ ] **Step 5: Confirm CI is green and the package is public**

Poll the Actions API for the run's conclusion. When the `image` job succeeds, confirm `ghcr.io/atvriders/jellyfin-logwatch` is public; if not, tell the owner to flip the package visibility once.

---

## Self-Review

**Spec coverage.** §3 architecture → Tasks 1–9. §4 log source, file selection, polling, rotation, truncation, waiting → Task 5, verified end to end in Task 10. §5 format and parsing including every listed rule → Task 2. §6 buffer and stats → Tasks 3, 4. §7 every route in the table, SSE batching, heartbeat, `Last-Event-ID` replay → Tasks 8, 9. §8 auth, token revocation, lockout, `TRUST_PROXY` → Tasks 6, 7, 9. §9 both screens, rendering rules, virtualization → Tasks 12–15. §10 config table → Task 1, surfaced in Tasks 16 and 19. §11 Docker and CI → Tasks 16, 17. §12 testing → Tasks 2–11, 18. §13 deployment → Task 16. §14 owner verification → Task 19 README plus the handoff notes.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. The one deliberately open item is Task 15's aesthetic direction, which is delegated to the `frontend-design` skill with six concrete acceptance requirements — a decision, not a placeholder.

**Type consistency.** `ParsedEntry` (Task 2) is what `EntryBuffer.add` (Task 3) consumes and `Pipeline.emit` (Task 8) passes. `Snapshot` gained `lastSeq` in Task 1's types and is used by Task 9's route and Task 11's hook. `SseHub.publish` takes the union `'rotate' | 'waiting' | 'resnapshot'` in Tasks 8, 9 and 11 alike. `Filters` is defined once in Task 11 and consumed unchanged in Tasks 14. The e2e selectors in Task 18 (`data-testid="feed"`, `data-testid="entry"`, `▸ N more lines`, `errors only`, `paused`) all exist verbatim in Tasks 13 and 14, and Task 15 is explicitly forbidden from changing them.
