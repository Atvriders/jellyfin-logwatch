# CLAUDE.md — Jellyfin Logwatch

## Never commit the owner's real network details

This repo is **public**. Everything committed must use placeholders, never the owner's actual
setup. The owner substitutes the real values on their own machine and does not want them pushed.

| Committed value | Must stay | Never commit |
|---|---|---|
| `JELLYFIN_URL` | `http://your-jellyfin-host:8096` | the real LAN IP or hostname |
| log bind mount | `/path/to/jellyfin/log:/logs:ro` | the real appdata path |
| example IPs in docs, fixtures and screenshots | RFC 5737 ranges (`198.51.100.x`, `203.0.113.x`) or `.example` / `.test` names | anything on the owner's real subnet |
| `JELLYFIN_API_KEY`, `SESSION_SECRET` | `your_api_key_here`, `change_this_to_a_long_random_string` | a real key or secret |

This applies to **`docker-compose.yml`, `.env.example`, `README.md`, `docs/`, test fixtures, and
any screenshot**. A screenshot leaks a subnet just as effectively as a config file — the seeded
log used to render `docs/screenshot.png` must also use documentation-range addresses.

Before any commit, check:

```bash
grep -rInE '192\.168\.|10\.[0-9]+\.|/mnt/user/appdata' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
```

Generic Unraid guidance in prose (e.g. "commonly `/mnt/user/appdata/jellyfin/log`") is fine — that
is standard for every Unraid user and identifies nobody. The rule is about *config values and
rendered output*, not documentation about the platform.

## Things that will bite you

- **Polling, never inotify.** `LogFileWatcher` `stat()`s the file and reads from a byte offset.
  Unraid's `/mnt/user` is FUSE (shfs) where `fs.watch` may never fire, so an inotify-based watcher
  passes every test here and then silently stops updating on the real box. Do not "optimise" it.
- **The active log file is chosen by greatest mtime**, never by computing today's date — the
  container's timezone and Jellyfin's can differ.
- **`.js` extensions are mandatory** on every relative import under `src/server` and `src/shared`
  (`tsconfig.server.json` uses `module: NodeNext`). Omitting one fails `npm run typecheck` even
  though vitest resolves it fine.
- **The sandbox is not UTC.** `vitest.config.ts` pins `TZ=UTC`; any test that round-trips a naive
  timestamp will otherwise pass locally and fail in CI, or vice versa.
- **Express 5**: `req.params.id` is `string | string[]`, so `req.params.id!` does not compile —
  type the handler `Request<{ id: string }>`. `app.get('*')` throws; the SPA fallback uses the
  regex route `/^(?!\/api\/).*/`.
- **These selectors are load-bearing for the e2e suite** — renaming them silently breaks it:
  `data-testid="feed"`, `data-testid="entry"`, the follow toggle's `following`/`paused` text,
  the trace toggle's `▸ N more lines`, `role="alert"`, placeholder `Password`, and the buttons
  named `Sign in`, `errors only`, `all`.

## Verification gate

All four must pass before committing:

```bash
npm run typecheck   # client + server + tests/configs
npx vitest run      # 84 unit + integration
npm run build
npm run test:e2e    # 4 Playwright, needs npm run build first
```
