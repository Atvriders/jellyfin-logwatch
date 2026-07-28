import { test, expect, type Page } from '@playwright/test';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * End-to-end against the built client and the real server: sign-in, live
 * tailing, trace folding, filtering, and the promise that log text is text.
 * `tests/e2e/server.mjs` publishes the throwaway log directory it created;
 * appending to that file is exactly what Jellyfin does to its own log.
 */

const logDir = async () => (await readFile('tests/e2e/.logdir', 'utf8')).trim();

const append = async (text: string) =>
  appendFile(join(await logDir(), 'log_20260726.log'), text);

const stamp = (level: string, component: string, message: string) =>
  `[2026-07-26 22:14:03.123 -05:00] [${level}] [42] ${component}: ${message}\n`;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'james' }).click();
  await page.getByPlaceholder('Password').fill('correct-horse');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('feed')).toBeVisible();
}

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
  await signIn(page);

  await append(stamp('INF', 'Session.Manager', 'playback started'));
  // The trace lines share the write with their entry: a stack trace is part of
  // the line Jellyfin logged, not three lines that arrived separately.
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

  await signIn(page);

  await append(stamp('WRN', 'Http.Server', '<img src=x onerror="alert(1)"> <script>alert(2)</script>'));
  await expect(page.getByText('<img src=x onerror=')).toBeVisible({ timeout: 10_000 });

  // Printed, not parsed: the exact bytes from the log, no element built from them.
  await expect(page.getByText('<img src=x onerror=')).toHaveText(
    '<img src=x onerror="alert(1)"> <script>alert(2)</script>',
  );
  expect(alerts).toHaveLength(0);
  expect(await page.locator('[data-testid="entry"] img').count()).toBe(0);
  expect(await page.locator('[data-testid="entry"] script').count()).toBe(0);
});

test('pauses following when scrolled up', async ({ page }) => {
  await signIn(page);

  for (let i = 0; i < 120; i++) await append(stamp('INF', 'Bulk.Filler', `line ${i}`));
  await expect(page.getByText('line 119')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'following' })).toBeVisible();

  const feed = page.getByTestId('feed');
  await feed.hover();

  // Scroll up while a re-pin is IN FLIGHT, not after the feed settles. The
  // re-pin retries fire for up to 320ms after rows arrive or the viewport
  // reflows, and a reader who reaches for the tape inside that window used to
  // get snapped back to the tail with their scroll swallowed — precisely when a
  // busy server makes you want to stop and read. A viewport change is in the
  // same effect's dependencies, so it schedules those retries deterministically
  // on any machine; relying on log lines arriving instead lets a fast host win
  // the race by accident and the assertion then proves nothing.
  await page.setViewportSize({ width: 1280, height: 780 });

  // Assert the gesture landed before asserting what it should have caused, so a
  // failure says which link broke: a feed that never scrolled is an environment
  // problem, a feed that scrolled without pausing is an application bug.
  await expect
    .poll(async () => feed.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  const startedAt = await feed.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, -2000);
  await expect
    .poll(async () => feed.evaluate((el) => el.scrollTop), {
      message: 'the wheel gesture did not scroll the feed',
    })
    .toBeLessThan(startedAt);

  await expect(page.getByRole('button', { name: 'paused' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'following' })).toHaveCount(0);

  // And it must STAY where the reader put it, rather than drifting back to the
  // tail as the remaining lines land.
  const scrollTop = await feed.evaluate((el) => el.scrollTop);
  const bottom = await feed.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrollTop).toBeLessThan(bottom - 40);
  await page.waitForTimeout(600);
  expect(await feed.evaluate((el) => el.scrollTop)).toBe(scrollTop);
});
