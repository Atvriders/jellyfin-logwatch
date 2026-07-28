# Jellyfin Logwatch — Design

**Date:** 2026-07-26
**Status:** Approved for planning
**Repo:** `~/jellyfin-logwatch` → `Atvriders/jellyfin-logwatch` (public)
**Image:** `ghcr.io/atvriders/jellyfin-logwatch` (public, multi-arch)

## 1. Purpose

A web dashboard that watches the Jellyfin server's log file on an Unraid box and
presents it as a live, readable feed. It replaces squinting at
`docker logs -f -n 90 jellyfin` in a browser tab, where a single Entity Framework
exception buries sixty lines of stack trace over everything else.

The dashboard is a **pure viewer**. It never writes to Jellyfin, never deletes or
edits logs, and never sends anything outbound.

### Success criteria

1. Opening the dashboard shows the recent log tail within one second, then new
   lines appear within ~1s of being written.
2. A 60-line stack trace occupies **one** row in the feed until expanded.
3. Filtering to `ERROR` answers "what is broken right now" in one click.
4. Any Jellyfin user can log in with their normal Jellyfin password.
5. `docker compose up -d` on Unraid is the entire install.

## 2. Non-goals

Deliberately excluded, to keep the surface small:

- No database, no persistence of any kind.
- No rotated-day history — the current log file only.
- No alerting: no email, webhooks, Discord, or browser notifications.
- No Docker socket access and no other containers' logs.
- No log mutation (no clearing, no rotation, no level changes).
- No multi-server support — one Jellyfin instance per deployment.

## 3. Architecture

One Docker container running a Node process that both tails the log and serves
the UI.

```
Unraid host                         container
┌──────────────────────────────┐    ┌────────────────────────────────────────┐
│ <host jellyfin log dir>      │    │  LogFileWatcher ──► LineParser         │
│   log/log_20260726.log ──────┼─ro─┼─►      │                  │            │
└──────────────────────────────┘    │        │                  ▼            │
                                    │        │            EntryBuffer (ring) │
┌──────────────────────────────┐    │        │                  │            │
│ Jellyfin @ :8096             │◄───┼── JellyfinClient          ▼            │
│  /Users/AuthenticateByName   │    │        │            StatsEngine        │
│  /Sessions/Logout (no key)   │    │        ▼                  │            │
└──────────────────────────────┘    │   SessionAuth ──► Express 5 ◄──────────┤
                                    │                     │  SSE + REST      │
                                    └─────────────────────┼──────────────────┘
                                                          ▼
                                                    React 19 SPA
```

**Stack:** Node 24 (runtime image) / TypeScript strict · Express 5 · React 19 ·
Vite 7 · vitest · Playwright. The local sandbox runs Node 20.20.2, which
satisfies Vite 7's `^20.19 || >=22.12` requirement; CI and the runtime image use
Node 24.

**Transport:** Server-Sent Events. One-way, auto-reconnecting in the browser,
and it survives a Cloudflare Tunnel without the WebSocket upgrade dance.

### Module boundaries

Each module is independently testable and depends only on the interface below it.

| Module | Responsibility | Depends on |
|---|---|---|
| `LogFileWatcher` | Select the active log file, poll for growth, emit raw lines | fs only |
| `LineParser` | Raw line → `LogEntry`, folding continuation lines into traces | nothing (pure) |
| `EntryBuffer` | Fixed-size ring of parsed entries, assigns `seq` | nothing |
| `StatsEngine` | Rolling counts, per-minute buckets, noisy components, rate | clock |
| `JellyfinClient` | Verify a typed username + password, revoke the token | fetch |
| `SessionAuth` | Cookie sessions, lockout policy | `JellyfinClient` |
| `httpServer` | REST + SSE routes, static SPA hosting | all of the above |

A module that grows past ~250 lines is a signal to split it.

## 4. Log source

`LOG_DIR` (default `/logs`) is a **read-only** bind mount of
the directory Jellyfin writes `log_*.log` into on the host.

### File selection

The watcher does **not** compute "today" from the clock — the container's
timezone and Jellyfin's may differ. Instead:

1. Scan `LOG_DIR` for files matching `log_*.log`.
2. Select the one with the greatest mtime. That is the active file.
3. Re-scan every `RESCAN_INTERVAL_MS` (default 5000). If a different file wins,
   switch to it, reset the offset to 0, and emit a `rotate` event so the UI
   draws a day divider.

This handles midnight rotation, timezone drift, and a Jellyfin restart that
creates a new file, without any date arithmetic.

### Reading

**Polling, not inotify.** Unraid's `/mnt/user` is a FUSE filesystem (shfs) where
inotify events are unreliable or absent, so `fs.watch` cannot be the primary
mechanism. The watcher `stat()`s the active file every `POLL_INTERVAL_MS`
(default 750) and reads from the last byte offset when `size` grows.
`fs.watch` may be registered as an optional accelerator, but correctness never
depends on it firing.

- **Startup:** read the last `STARTUP_TAIL_BYTES` (default 262144) of the active
  file so the feed opens with context. If the read starts mid-line, discard the
  first partial line.
- **Growth:** read `[offset, size)`, split on `\n`, hold any trailing partial
  line until the next poll completes it.
- **Truncation:** if `size < offset`, the file was truncated — reset offset to 0
  and re-read from the start.
- **Missing directory or no matching files:** surface a clear "waiting for log
  file" state to the UI rather than crashing; keep re-scanning.

## 5. Log format and parsing

Jellyfin 10.11's default file sink template is:

```
[{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz}] [{Level:u3}] [{ThreadId}] {SourceContext}: {Message:l}{NewLine}{Exception}
```

producing lines such as:

```
[2026-07-26 22:14:03.123 -05:00] [ERR] [42] Jellyfin.Database.Implementations.JellyfinDbContext: Error saving changes
```

### Rules

1. **Primary pattern** — timestamp, three-letter level, thread id, source
   context, message. Component match is non-greedy up to the first `": "`.
2. **Secondary pattern** — the console-style template
   `[HH:mm:ss] [LVL] [Component] message`, for users who customized
   `logging.json`. It carries no date, so the parser takes the date from the
   active file's name (`log_YYYYMMDD.log`) and falls back to the file's mtime
   day when the name does not match that form.
3. **Component boundary** — the component is matched non-greedily up to the
   first `": "`, so a message that itself contains `": "` cannot swallow the
   component. Everything after that first separator is the message, verbatim.
4. **Continuation** — any line matching neither pattern is appended to the
   previous entry's `trace[]`. This is what folds a 60-line EF Core exception
   into one row.
5. **Orphan continuation** — a continuation line with no preceding entry (the
   tail read began mid-trace) becomes its own entry with `level: "raw"`.
6. **Never drop a line.** Every byte read appears somewhere in the feed.
7. **Trace cap** — `MAX_TRACE_LINES` (default 500) per entry; further lines are
   replaced by a single `… N more lines truncated` marker so one pathological
   exception cannot exhaust memory.

### Level mapping

`VRB`→verbose, `DBG`→debug, `INF`→info, `WRN`→warn, `ERR`→error, `FTL`→fatal,
anything else →`raw`.

### Entry shape

```ts
interface LogEntry {
  seq: number;              // monotonic, assigned by EntryBuffer
  ts: string | null;        // ISO 8601, null when unparseable
  level: Level;             // verbose|debug|info|warn|error|fatal|raw
  thread: number | null;
  component: string | null; // e.g. "Jellyfin.Api.Middleware.ExceptionMiddleware"
  message: string;
  trace: string[];          // [] for single-line entries
  traceTruncated: boolean;
}
```

## 6. Buffer and statistics

- **Ring buffer**, `BUFFER_SIZE` entries (default 5000). Oldest evicted first.
  This is the only storage in the system; a restart starts fresh.
- **StatsEngine** maintains a 15-minute window in 1-minute buckets:
  - per-level counts over the window,
  - a 15-point sparkline series of total volume,
  - top 5 components by entry count,
  - current lines/second.
  Buckets older than the window are dropped on each tick, so memory is bounded.
- Stats are computed from entries as they arrive, not by rescanning the buffer.

## 7. HTTP API

Unauthenticated routes: `/api/session`, `/api/login`, `/api/logout`,
`/api/health`, and static assets — the session/login/logout trio because the
login screen must work before anyone is logged in, and health because Docker
probes it. **No route discloses anything about who has an account**: `/api/session`
reports only on the caller's own cookie, and `/api/login` answers identically for
an unknown username and a wrong password. Every other route, including all log
data, requires an authenticated session and returns `401 unauthorized` without one.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/session` | `{ authenticated, username }` for the caller's own cookie |
| POST | `/api/login` | `{ username, password }` → sets session cookie. Rate limited per IP |
| POST | `/api/logout` | Clears the session |
| GET | `/api/snapshot?limit=` | `{ entries, stats, source: { file, waiting }, lastSeq }` |
| GET | `/api/stream` | SSE: `entries`, `stats`, `rotate`, `waiting`, `resnapshot`, plus a heartbeat comment |
| GET | `/api/health` | Liveness for the Docker `HEALTHCHECK` |

### SSE behaviour

- Entries are batched and flushed at most every 100 ms (10 Hz), max 500 entries
  per flush. Under a debug-level flood the UI degrades to "showing latest" rather
  than locking up the browser.
- A `heartbeat` comment every 20 s keeps proxies from idling the connection out.
- The client sends `Last-Event-ID` on reconnect; the server replays from that
  `seq` if it is still in the ring, otherwise it signals a full resnapshot.

## 8. Authentication

**The app holds no Jellyfin credential.** There is no API key, no service
account, and no long-lived token anywhere in the container or its configuration.
The username is typed, and the **password** is always verified by Jellyfin itself.

1. The login screen is a username field and a password field. It never asks
   Jellyfin who exists, because nothing here can: `JellyfinClient` has no
   admin-scoped call.
2. On submit, `POST /Users/AuthenticateByName` with `{ Username, Pw }` and a
   proper
   `Authorization: MediaBrowser Client="Jellyfin Logwatch", Device="...", DeviceId="...", Version="..."`
   header. Jellyfin rejects the request without it. No `X-Emby-Token` is sent —
   the typed credentials are the only authentication.
3. On success, immediately `POST /Sessions/Logout` with the returned access token
   — before the login response is written — so no Jellyfin credential is
   retained. That token is the only one the process ever holds, and revocation is
   best-effort: a failure there never fails the login, since the token expires on
   its own. The session cookie stores only the username, user id, and issue time.
4. Cookie: `httpOnly`, `sameSite=lax`, signed with `SESSION_SECRET`, 7-day max
   age. `secure` is taken from the actual request scheme (`req.secure`, which
   honours `X-Forwarded-Proto` once `TRUST_PROXY=1` enables Express's `trust
   proxy`) — never from `TRUST_PROXY` itself, so a plain-HTTP LAN deployment
   still works and an HTTPS one is never downgraded.
5. **Indistinguishable failures.** Jellyfin returns 401 for an unknown username
   and for a wrong password alike, and the route passes that through as a single
   `401 { error: "invalid_credentials" }` with one UI message. No branch on the
   username exists in the login path, so the endpoint cannot be used to enumerate
   accounts.
6. **Lockout:** 5 failed attempts from one IP within 5 minutes → 15-minute block.
   A failure caused by Jellyfin being unreachable consumes no attempt and is
   reported as `503 jellyfin_unreachable`, never as a credential failure.
7. **Rate limit:** `POST /api/login` is additionally limited to 30 requests per
   minute per IP, checked before body validation. The lockout only counts
   password rejections, so the limiter is what bounds malformed bodies and
   attempts made while Jellyfin is down. Both counters are in-process and are
   pruned so a spray of forged `X-Forwarded-For` values cannot grow them without
   bound.
8. `TRUST_PROXY=1` makes the rightmost `X-Forwarded-For` token the client IP for
   both the lockout and the rate limit.

**Residual exposure.** With no user list published, the only pre-auth surface is
the login form itself, `/api/session` (caller's own cookie only), `/api/logout`,
`/api/health`, and the static SPA. That is a smaller target, not a zero one: it is
still a password form anyone who can reach the port may POST to. On a public
hostname — a Cloudflare Tunnel in particular — put an identity policy such as
Cloudflare Access in front of it and set `TRUST_PROXY=1`.

## 9. Frontend

Two screens. Aesthetic direction is chosen during implementation via the
`frontend-design` skill; this spec fixes only the structure and behaviour.

### Login

A username field, a password field, one submit button — no account list and no
avatars, so the screen discloses nothing about who has an account. Error states
for wrong username-or-password (one message covering both), Jellyfin unreachable,
and locked out.

### Dashboard

1. **Stats strip** — per-level counts for the last 15 minutes, a volume
   sparkline, the top noisy components, current lines/sec, and the active file
   name.
2. **Filter bar** — level toggles, component filter (click a component in a row
   to isolate it), substring search, and a follow/pause control.
3. **Feed** — virtualized list, newest at the bottom. Each row: level badge,
   local-time timestamp, component, message. Rows with a trace show
   `▸ N more lines` and expand in place. Auto-follows while scrolled to the
   bottom; scrolling up pauses follow and shows an "N new" jump-to-bottom pill.
4. **Day divider** on `rotate`, and a "waiting for log file" placeholder when no
   file matches.

### Rendering rules

- Log text is inserted as `textContent` only — never `innerHTML`, never
  `dangerouslySetInnerHTML`. Stack traces contain attacker-influenceable strings
  (user agents, URLs, media filenames).
- Filtering and search run client-side over the buffered entries.
- Timestamps render in the browser's local timezone from the parsed offset.

## 10. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `JELLYFIN_URL` | — (required) | Jellyfin base URL, e.g. `http://your-jellyfin-host:8096` |
| `SESSION_SECRET` | — (required) | Cookie signing key; random string |
| `LOG_DIR` | `/logs` | Mounted Jellyfin log directory (read-only) |
| `PORT` | `3000` | Container listen port |
| `BUFFER_SIZE` | `5000` | Ring buffer entries |
| `POLL_INTERVAL_MS` | `750` | Log file growth poll |
| `RESCAN_INTERVAL_MS` | `5000` | Active-file re-selection interval |
| `STARTUP_TAIL_BYTES` | `262144` | Backfill read size on start |
| `MAX_TRACE_LINES` | `500` | Per-entry trace cap |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy / tunnel |

Startup validates required variables and exits with a readable message naming the
missing variable rather than failing later at first use. Variables it does not
recognise are ignored, never an error — `JELLYFIN_API_KEY` was required before the
account picker was removed, and deployed compose files that still set it must keep
starting unchanged.

## 11. Docker and CI

**Image:** multi-stage — `node:24-alpine` builder (install, typecheck, build
client and server) → `node:24-alpine` runtime with production deps only, running
as a non-root user, `HEALTHCHECK` hitting `/api/health`.

**GitHub Actions** (`push` to `master` + `workflow_dispatch`):

1. `verify` — install, typecheck, lint, `vitest run`, build, Playwright e2e.
2. `image` — needs `verify`; buildx multi-arch `linux/amd64,linux/arm64`, push
   `ghcr.io/atvriders/jellyfin-logwatch:latest` and the commit SHA tag.

Repo and package are **public**. Known fleet gotcha: on a fresh repo the first
build may need a manual `workflow_dispatch` before push-triggered builds run.

## 12. Testing

**Unit (vitest)**

- Parser: the exact 60-line EF Core trace from the reported screenshot folds into
  one entry with 60 trace lines; primary and secondary templates; orphan
  continuation; trace cap; every level code; a line containing `": "` inside the
  message does not corrupt the component.
- Watcher: append → new lines; truncate → re-read from 0; new file with a newer
  mtime → switch + `rotate`; partial trailing line completed on the next poll;
  empty directory → waiting state. All against temp directories, no Jellyfin.
- Buffer: eviction order, monotonic `seq`, replay-from-seq hit and miss.
- Stats: bucket expiry at the window edge, level counts, top components, rate.
- Auth: success revokes the Jellyfin token, and revokes it with that token rather
  than any stored credential; an unknown username and a wrong password produce
  identical responses; unreachable Jellyfin consumes no lockout attempt; lockout
  threshold and expiry; the login rate limit bounds requests the lockout never
  counts; `loadConfig` accepts an environment that still sets `JELLYFIN_API_KEY`.

**Integration** — write to a temp log file and assert the SSE stream delivers
matching entries in order, including across a simulated rotation.

**E2E (Playwright)** — login as a mocked Jellyfin user → feed renders → filter to
errors → expand a trace → scroll up pauses follow → jump-to-bottom resumes.
A stored-XSS probe (`<img src=x onerror=...>` written into the log file) is
asserted inert in a real browser.

## 13. Deployment

```yaml
services:
  jellyfin-logwatch:
    image: ghcr.io/atvriders/jellyfin-logwatch:latest
    ports:
      - "5460:3000"
    environment:
      - JELLYFIN_URL=http://your-jellyfin-host:8096
      - SESSION_SECRET=change_this_to_a_long_random_string
      # - TRUST_PROXY=1        # behind a reverse proxy or Cloudflare Tunnel
    volumes:
      # REQUIRED, read-only. Must be Jellyfin's log directory on the host.
      - /path/to/jellyfin/log:/logs:ro
    restart: unless-stopped
```

No writable volume is needed — nothing is persisted by design. No API key is set,
because none is read; an existing deployment can delete that line and revoke the
key in Jellyfin.

Published beyond the LAN — a Cloudflare Tunnel being the intended case — front it
with an identity policy (Cloudflare Access or equivalent) and set `TRUST_PROXY=1`
so the lockout and rate limit key on the real client IP. Removing the user list
reduces exposure; it does not remove it.

## 14. Owner verification after deploy

1. Confirm the mounted host path is the real log directory on the Unraid
   box and contains `log_*.log` files.
2. Confirm the feed advances when Jellyfin is used (start a playback).
3. Confirm login works for at least one non-admin Jellyfin account, by typing its
   username.
4. Confirm the container still starts with the old `JELLYFIN_API_KEY` line left in
   place, then delete the line and revoke the key in Jellyfin.
