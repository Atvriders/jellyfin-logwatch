import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

/**
 * Which Chromium to drive.
 *
 * CI runs `npx playwright install --with-deps chromium`, so Playwright's own
 * pinned build is there and we use it — that is the browser the project is
 * tested against. A developer machine often has a *different* build cached
 * (installed for some other Playwright version), and launching then dies with
 * "Executable doesn't exist"; there we fall back to the system Google Chrome.
 * `PLAYWRIGHT_CHANNEL` forces either choice: `chrome` for the system browser,
 * empty for the pinned build.
 */
function browserChannel(): string | undefined {
  const forced = process.env.PLAYWRIGHT_CHANNEL;
  if (forced !== undefined) return forced || undefined;
  return pinnedChromiumInstalled() ? undefined : 'chrome';
}

function pinnedChromiumInstalled(): boolean {
  let executable: string;
  try { executable = chromium.executablePath(); } catch { return false; }
  if (!existsSync(executable)) return false;
  // A headless run launches the separate headless-shell build, not this
  // binary, so half an install is still no browser. The marker file
  // `playwright install` writes on success is the platform-independent proof.
  const build = dirname(dirname(executable));
  const shell = build.replace(/chromium-(\d+)$/, 'chromium_headless_shell-$1');
  return shell === build || existsSync(join(shell, 'INSTALLATION_COMPLETE'));
}

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // One worker, no retries: every test appends to the same log file, and a
  // second pass would leave two copies of a line the assertions expect once.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3999',
    channel: browserChannel(),
    trace: 'retain-on-failure',
    // The log lines are stamped -05:00; pin the clock so the rendered times
    // are the same on a developer machine as they are on a UTC runner.
    timezoneId: 'America/Chicago',
    locale: 'en-US',
  },
  webServer: {
    command: 'node --import tsx tests/e2e/server.mjs',
    url: 'http://127.0.0.1:3999/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
