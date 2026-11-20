// The app lock, end to end, against a dev server started with APP_PASSWORD set (playwright.config.mjs).
// Market data is still mocked; the three sign-in calls and /api/vault go to the real handlers.
import { test, expect } from '@playwright/test';
import { mockApi, watchErrors } from './fixtures.mjs';
import { LOCKED_PORT, LOCK_TEST } from '../playwright.config.mjs';

test.use({ baseURL: `http://localhost:${LOCKED_PORT}` });
const VAULT = `/api/vault?op=get&id=${'0'.repeat(64)}`;
async function setup(page) {
  await mockApi(page);
  await page.route(/\/api\/notify\?op=(session|login|logout)/, (r) => r.continue());   // the real sign-in
  await page.route(/\/api\/vault/, (r) => r.continue());
}
async function signIn(page, password = LOCK_TEST.password) {
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a visitor without the password sees only the sign-in page; data and files are refused', async ({ page, request }) => {
  await setup(page);
  await page.goto('/swing');
  await expect(page).toHaveURL(/\/login\?next=%2Fswing$/);
  await expect(page.getByRole('heading', { name: 'Signal Desk' })).toBeVisible();
  for (const path of [VAULT, '/api/quotes?tickers=SPY', '/api/notify?op=status', '/data/screen.json', '/strategies.js']) {
    const r = await request.get(path, { maxRedirects: 0 });
    expect(r.status(), path).toBe(401);
  }
  for (const path of ['/dashboard', '/alerts', '/', '/handbook']) expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(302);
  expect((await request.get('/privacy')).status()).toBe(200);
  expect((await request.get('/api/notify?op=session')).ok()).toBe(true);
});

test('wrong password is refused; the right one opens the page that was asked for, and Sign out locks it again', async ({ page }) => {
  const errors = watchErrors(page);
  await setup(page);
  await page.goto('/swing');
  await signIn(page, 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText('Wrong password.');
  await expect(page).toHaveURL(/\/login/);

  await signIn(page);
  await expect(page).toHaveURL(/\/swing$/);
  await expect(page.locator('.tabbar-tabs .tab.on').first()).toHaveText('Swing');
  // the session cookie is out of reach of page scripts; only the harmless marker is visible
  expect(await page.evaluate(() => document.cookie)).not.toContain('sd_session');
  expect((await page.request.get(VAULT)).status()).toBe(200);

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get(VAULT)).status()).toBe(401);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  expect(errors).toEqual([]);
});

test('sign-in never forwards to another site, and an already signed-in device skips the form', async ({ page }) => {
  await setup(page);
  await page.goto('/login?next=//evil.example/x');
  await signIn(page);
  await expect(page).toHaveURL(new RegExp(`^http://localhost:${LOCKED_PORT}/$`));
  await page.goto('/login?next=/alerts');
  await expect(page).toHaveURL(/\/alerts$/);
});

test("the owner's scheduled jobs get through with the owner key, and only with the right one", async ({ request }) => {
  expect((await request.get(VAULT, { headers: { Authorization: `Bearer ${LOCK_TEST.ownerKey}` } })).status()).toBe(200);
  expect((await request.get('/data/earnings.json', { headers: { Authorization: `Bearer ${LOCK_TEST.ownerKey}` } })).status()).toBe(200);
  expect((await request.get(VAULT, { headers: { Authorization: 'Bearer wrong-key' } })).status()).toBe(401);
});
