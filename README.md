# Jellyfin Logwatch

A small web app that tails your Jellyfin server's log file and shows it live in the browser, with
levels, search, folded stack traces and a 15-minute error meter. It is strictly **read-only**: it
opens the log file for reading and nothing else, and it **stores nothing** — no database, no
volume, no files written anywhere. Everything it knows lives in memory and is gone when the
container restarts.

![The Jellyfin Logwatch dashboard: a header reading 4 errors and 13 warnings beside a 15-minute error load meter, a volume sparkline and the noisiest components; below it a level filter rail, then the live feed with a time spine down the left edge, notched red where an error and a fatal occurred.](docs/screenshot.png)

## Quick start

### 1. Make a Jellyfin API key

In Jellyfin: **Dashboard > Advanced > API Keys > + (New Key)**. Name it anything (`logwatch` is
fine) and copy the key. See [How login works](#how-login-works) for what the key is and is not
used for.

### 2. docker-compose.yml

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

Fix the three things that are specific to your machine — `JELLYFIN_URL`, `JELLYFIN_API_KEY`, a
long random `SESSION_SECRET` — and check the left-hand side of the volume actually is Jellyfin's
log **directory** (the one containing `log_20260726.log` and friends). Then:

```
docker compose up -d
```

and open `http://<host>:5460`.

To build the image yourself instead of pulling it: `docker build -t jellyfin-logwatch .` and point
`image:` at that tag.

## How login works

Anyone with a **Jellyfin account on your server** can sign in. There are no separate accounts,
no password to invent, nothing to provision.

- The **API key only lists users** for the login screen — one `GET /Users` call, so the screen can
  show names and avatars. Disabled accounts are filtered out.
- **Jellyfin verifies the password**, not this app. The password you type is posted straight to
  Jellyfin's `POST /Users/AuthenticateByName`. This app never sees a password hash and never
  stores the password.
- **The access token Jellyfin returns is revoked immediately** — `POST /Sessions/Logout` runs
  before the login response is even sent. The token is never written down and never reused; it
  exists only to prove the password was right.
- What you get back is a signed, `httpOnly`, `SameSite=Lax` session cookie holding your username
  and Jellyfin user id, valid for 7 days. It is signed with `SESSION_SECRET`; changing that secret
  signs everyone out. There is no server-side session store.
- The cookie is marked `Secure` when the request is HTTPS, so a plain-HTTP LAN deployment still
  works and an HTTPS one is not downgraded.
- Failed logins are rate-limited per client IP: 5 failures in 5 minutes blocks that IP for 15
  minutes.
- `GET /api/users` and the avatar proxy have to be reachable before anyone signs in, or the login
  screen cannot render — so they are unauthenticated, and they list every enabled Jellyfin
  username. That is the same thing Jellyfin's own login screen does, but it means **anyone who can
  reach this port can read your user list**. They are limited to 30 requests per minute per IP,
  which blunts enumeration and stops the endpoint being used to hammer Jellyfin, but it is not a
  substitute for access control. Keep this on your LAN or behind an authenticated tunnel.

## Environment variables

Three are required; the container refuses to start without them, naming the one that is missing.
Every optional numeric setting must be a positive integer or startup fails the same way.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `JELLYFIN_URL` | yes | — | Base URL of your Jellyfin server, e.g. `http://your-jellyfin-host:8096`. Trailing slashes are stripped. Must be reachable *from inside the container*. |
| `JELLYFIN_API_KEY` | yes | — | Jellyfin API key. Used only to list users and fetch their avatars. |
| `SESSION_SECRET` | yes | — | Key the session cookie is signed with. Use a long random string. Changing it signs everyone out. |
| `LOG_DIR` | no | `/logs` | Directory inside the container where Jellyfin's logs are mounted. Must be the directory, not a single file. |
| `PORT` | no | `3000` | Port the server listens on inside the container. |
| `BUFFER_SIZE` | no | `5000` | How many parsed entries are held in memory. Older ones fall off the back. |
| `POLL_INTERVAL_MS` | no | `750` | How often the active log file is checked for new bytes. |
| `RESCAN_INTERVAL_MS` | no | `5000` | How often the directory is re-listed to notice a rotation. |
| `STARTUP_TAIL_BYTES` | no | `262144` | How much of the file's tail is read on first attach, so the feed is not empty. 256 KiB. |
| `MAX_TRACE_LINES` | no | `500` | Cap on stack-trace lines folded into one entry. The remainder is reported as `… N more lines truncated`. |
| `TRUST_PROXY` | no | off | Set to exactly `1` behind a reverse proxy. See [Behind a reverse proxy](#running-behind-a-reverse-proxy). |

`.env.example` lists the same variables in copy-paste form. Note that the server itself has no
dotenv loader — it reads `process.env` — so a `.env` file only reaches it via Docker Compose's
`env_file:` / `--env-file`, or by exporting the values yourself.

## Scope

This is deliberately a window on the **current log file**, not a log platform.

- **The current file only.** It follows the newest `log_*.log` in `LOG_DIR` and, when Jellyfin
  rolls over to a new one, follows that instead. Yesterday's file is not read.
- **No history.** There is no database, no search over rotated days, no retention setting. The
  in-memory buffer holds the last `BUFFER_SIZE` entries and the 15-minute meter holds 15 minutes.
  Restart the container and both are empty again.
- **No alerting.** No email, no webhooks, no notifications, no rules.
- **No writing.** It never edits, deletes or rotates a log, which is why the volume is mounted
  `:ro`.

The reason is the container: with no state there is nothing to back up, nothing to migrate,
nothing to corrupt, and no data volume to reason about. `docker rm` and `docker run` is a complete
recovery procedure. If you need retention and alerting, that is a job for a real log stack
shipping the same files; this is the thing you open when you want to see what Jellyfin is doing
*right now*.

## How it reads the log

**By polling and byte offsets — not inotify.** This is the single most useful thing to know about
this app.

On Unraid, `/mnt/user` is a FUSE layer (`shfs`) over the array, and inotify events do not come
through it reliably — a watcher can sit perfectly silent while the file grows underneath it. The
same is true of most network mounts (SMB, NFS) and of some bind-mount setups. So there is no
`fs.watch` anywhere in this codebase. Instead:

- Every `RESCAN_INTERVAL_MS` (5 s) it lists `LOG_DIR`, keeps the files matching `log_*.log`, and
  picks the one with the newest mtime. That is the active file.
- On first attach it seeks to `STARTUP_TAIL_BYTES` (256 KiB) before the end, discards the first
  partial line, and parses forward — so the feed has recent context the moment you open it.
- Every `POLL_INTERVAL_MS` (750 ms) it `stat`s the active file. Same size: nothing to do. Bigger:
  read exactly the new bytes from the stored offset and parse them. Smaller: assume it was
  truncated in place and start again from byte 0.
- If a rescan finds a *different* newest file, that is a rotation. The offset resets, the feed
  draws a `new log file` divider, and reading continues in the new file.
- A trailing partial line is held back until its newline arrives, so a half-written line is never
  parsed as a whole one.

The cost of this is one `stat` every 750 ms and one `readdir` every 5 s. That is cheap even on
FUSE, and unlike an event subscription it cannot silently stop working.

Two Jellyfin line formats are recognised — the file format
`[2026-07-26 21:49:05.123 -05:00] [INF] [42] Component: message` and the date-less console format
`[21:49:05] [INF] [Component] message`. Continuation lines (stack traces) fold into the entry
above them, collapsed behind a `▸ N more lines` toggle. Anything that matches neither format is
still shown, tagged `raw`. Nothing is dropped.

## Troubleshooting

### "No log file in /logs yet"

The feed says this when the directory it is watching contains no `log_*.log`, and the header file
name reads `no source`. Almost always one of:

- **The mount points at the wrong path.** The left-hand side of the volume must be the directory
  Jellyfin actually writes to — commonly `/mnt/user/appdata/jellyfin/log`, sometimes
  `.../jellyfin/config/log`. Check inside the container: `docker exec jellyfin-logwatch ls /logs`.
- **The mount points at a single file.** `- /path/log_20260726.log:/logs:ro` cannot work; rotation
  and file discovery both need the directory. Mount the parent.
- **`LOG_DIR` and the volume disagree.** If you set `LOG_DIR` to something other than `/logs`, the
  right-hand side of the volume has to match it.
- **The files are not named `log_*.log`.** Only that pattern is picked up (case-insensitive).
- **The directory is not readable by the container's user.** The image runs as the unprivileged
  `node` user (uid 1000); a log directory only root can list looks exactly like an empty one.
  `docker exec jellyfin-logwatch ls /logs` will say `Permission denied` if this is your problem.

### The feed is not advancing

- **Check the follow toggle** at the right of the filter rail. It reads `following` or `paused`.
  Scrolling up the feed, or opening a stack trace, pauses it on purpose so the thing you are
  reading does not scroll away. Click it, or scroll back to the bottom, to resume.
- **Check the filters.** Level switches, the component dropdown and the search box all hide lines.
  The footer tells you the truth: `N shown · M filtered out`. The `all` preset switches every
  level back on.
- **Check the lamp** at the top right. `live` means the event stream is connected. `Reconnecting…`
  means the browser lost it — usually the container restarted, or a proxy closed the stream (see
  below). It reconnects on its own and replays what you missed.
- **Check the file name** in the header, printed under the title. If it is the file you expect,
  Jellyfin simply may not be logging anything; raise its logging level in **Dashboard > Logs** if
  you need more.

### Nobody can log in

The login screen saying *"Jellyfin is unreachable — nobody can sign in until it is back"* means
this app could not talk to Jellyfin. Passwords are checked by Jellyfin, so when Jellyfin is down
or misaddressed, every login fails regardless of what you type. Check:

- **`JELLYFIN_URL` from inside the container**, not from your desktop. `localhost` is a very common
  mistake: inside a container it means the container. Use the LAN IP or the compose service name.
- **The API key is still valid.** Deleting the key in Jellyfin's dashboard breaks the user list.
- **Jellyfin is actually up**, and if it is behind its own proxy, that the proxy is up too.

If it is only *you* who cannot get in and the message is *"Wrong password"* five times over, note
the lockout: 5 failures from one IP in 5 minutes blocks that IP for 15 minutes. Wait it out or
restart the container (the counter is in memory).

### Running behind a reverse proxy

Set `TRUST_PROXY=1`. Two things change:

- Client IPs for the login lockout and the public rate limit are taken from `X-Forwarded-For`
  instead of the socket, so one attacker cannot lock out everyone by looking like the proxy.
- `X-Forwarded-Proto` is honoured, so the session cookie is marked `Secure` whenever the
  *browser's* connection is HTTPS — including the common case where the proxy terminates TLS and
  talks plain HTTP to this container. The flag follows the real request scheme, not this setting,
  so an HTTP-only proxy will not lock you out of your own login.

Your proxy must also leave the event stream alone. The server sends `X-Accel-Buffering: no` and
`Cache-Control: no-cache, no-transform`, which nginx honours. On other proxies, turn response
buffering off for this app and make sure the read/idle timeout is comfortably above 20 seconds —
that is the stream's heartbeat interval, and a shorter timeout will cut the connection every 20 s.

## Development

Requires Node 20.19 or newer (the image builds on Node 24).

```
npm install
```

Two dev processes, in separate terminals:

```
npm run dev:server     # tsx watch on src/server, listens on :3000
npm run dev:client     # vite dev server, proxies /api to :3000
```

`JELLYFIN_URL`, `JELLYFIN_API_KEY` and `SESSION_SECRET` have to be in the server process's
environment before it starts, or it exits with a message naming the one that is missing; set
`LOG_DIR` too unless you really have a `/logs` directory locally. There is no dotenv loader — the
server reads `process.env` and nothing else — so export them, or prefix the command:

```
JELLYFIN_URL=http://your-jellyfin-host:8096 JELLYFIN_API_KEY=... SESSION_SECRET=dev \
  LOG_DIR=/path/to/jellyfin/log npm run dev:server
```

Then open the URL Vite prints, not `:3000`.

Tests:

```
npm test               # 84 unit + integration tests (vitest)
npm run test:e2e       # 4 Playwright tests against the built server + a mock Jellyfin
```

`npm run test:e2e` boots `dist/`, so run `npm run build` first. It also needs a browser:
`npx playwright install chromium` (the config falls back to a system Google Chrome if Playwright's
own pinned build is not installed).

Other scripts: `npm run typecheck` (client, server and tests), `npm run build` (Vite for the
client, `tsc` for the server, both into `dist/`), `npm start` (run the built server).
