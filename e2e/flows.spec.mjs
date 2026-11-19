import { test, expect } from '@playwright/test';
import { mockApi, watchErrors, answerDialog } from './fixtures.mjs';

const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

test('Today → Track → Dashboard → Close → journal', async ({ page }) => {
  const errors = watchErrors(page);
  await mockApi(page);
  await page.goto('/today');
  await expect(page.locator('#light-title')).toHaveText('Clear to trade at full size.');
  const kmi = page.locator('.pick', { hasText: 'KMI' });
  await expect(kmi).toContainText('Breaking out');
  await expect(page.locator('.pick', { hasText: 'DIS' })).toContainText('Pulling back');
  await expect(page.locator('.pick', { hasText: 'MSFT' })).toHaveCount(0);

  await kmi.getByRole('button', { name: /track/i }).click();
  expect(await answerDialog(page)).toContain('How many shares');
  await expect(kmi.getByRole('button', { name: /tracked/i })).toBeVisible();
  const book = await stored(page, 'sd-portfolio-v1');
  expect(book).toHaveLength(1);
  expect(book[0]).toMatchObject({ ticker: 'KMI', stop: 32.71, target: 38.73, assetClass: 'stock' });
  await expect(page.locator('.risk-box')).toContainText('positions 1/6');

  await page.goto('/dashboard');
  const card = page.locator('.pos-card', { hasText: 'KMI' });
  await expect(card).toContainText('Stop $32.71');
  await expect(card).toContainText(/HOLD|WATCH/);
  await card.getByRole('button', { name: 'Close' }).click();
  expect(await answerDialog(page, '36.00')).toContain('Exit price');
  await expect(page.locator('.pos-card')).toHaveCount(0);
  const journal = await stored(page, 'sd-journal-v1');
  expect(journal).toHaveLength(1);
  expect(journal[0]).toMatchObject({ ticker: 'KMI', exitPrice: 36 });
  expect(journal[0].r).toBeGreaterThan(0.8);                     // (36 − 34.43) / (34.43 − 32.71)
  expect(await stored(page, 'sd-portfolio-v1')).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('one market gate: index under its 50-day closes stock buys on Today, Swing and Stocks alike', async ({ page }) => {
  await mockApi(page, { indexDown: true });
  await page.goto('/today');
  await expect(page.locator('#light-title')).toHaveText('No new stock buys today.');
  await expect(page.locator('.pick', { hasText: 'Stock' })).toHaveCount(0);
  await expect(page.locator('.avoid-list')).toContainText('held back by the market gate');
  await page.goto('/swing');
  await expect(page.locator('#light-title')).toHaveText('No new buys today.');
  await expect(page.locator('#light-why')).toContainText('S&P 500 BELOW its 50-day');
  await expect(page.locator('[data-buy]')).toHaveCount(0);
  await page.goto('/');
  await expect(page.locator('.verdict-pill').first()).toBeVisible();
  await expect(page.locator('.verdict-pill.verdict-BUY')).toHaveCount(0);
});

test('elevated volatility: pullbacks only, on Today as on Swing', async ({ page }) => {
  await mockApi(page, { vix: 22 });
  await page.goto('/today');
  await expect(page.locator('#light-title')).toContainText('50% of normal size');
  await expect(page.locator('.pick', { hasText: 'DIS' })).toBeVisible();
  await expect(page.locator('.pick', { hasText: 'KMI' })).toHaveCount(0);
});

test('Swing: add to the watchlist → buy signal → paper buy → paper sell → scorecard; the list is shared with Alerts', async ({ page }) => {
  const errors = watchErrors(page);
  await mockApi(page);
  await page.goto('/swing');
  await expect(page.locator('#light-title')).toHaveText('Clear to buy at full size.');
  await page.locator('#sw-add').fill('kmi');
  await page.locator('#sw-add').press('Enter');
  const card = page.locator('#list .sw', { hasText: 'KMI' });
  await expect(card).toContainText('Buy signal');
  await expect(card).toContainText('Grade A');
  await expect(card).not.toContainText('no next-earnings date');
  await card.locator('[data-buy="KMI"]').click();
  await answerDialog(page);                                         // confirm (and price, if asked)
  if (await page.locator('dialog[open]').count()) await answerDialog(page);
  const open = page.locator('#book .sw', { hasText: 'KMI' });
  await expect(open).toContainText('Breakout');
  await expect(page.locator('#acct')).toContainText('1 of 6');
  const pos = (await stored(page, 'sd-swing-book-v1'))[0];
  expect(pos).toMatchObject({ ticker: 'KMI', strategy: 'breakout', book: 'swing' });
  expect(pos.qty * pos.buyPrice).toBeLessThanOrEqual(250.01);      // 25% of the $1,000 account
  expect(pos.qty * (pos.buyPrice - pos.stop)).toBeLessThanOrEqual(10.01);   // 1% risk

  await open.locator('[data-sell]').click();
  await answerDialog(page, '36.15');
  await expect(page.locator('#book')).toContainText('No paper trades yet');
  await expect(page.locator('#score')).toContainText('KMI');
  const j = await stored(page, 'sd-swing-journal-v1');
  expect(j).toHaveLength(1);
  expect(j[0].r).toBeCloseTo(1, 0);
  expect(errors, errors.join('\n')).toEqual([]);

  await page.goto('/alerts');
  await expect(page.locator('#watch')).toContainText('KMI');
});

test('earnings inside five days: the Swing card says avoid and offers no buy', async ({ page }) => {
  await mockApi(page, { earningsDays: 3 });
  await page.addInitScript(() => localStorage.setItem('sd-alerts-watch-v1', JSON.stringify(['KMI'])));
  await page.goto('/swing');
  const card = page.locator('#list .sw', { hasText: 'KMI' });
  await expect(card.locator('.pill')).toHaveText('Avoid');
  await expect(card).toContainText('Earnings in 3 days');
  await expect(card.locator('[data-buy]')).toHaveCount(0);
});

test('economic calendar unreadable: the Swing light says so instead of "no release ahead"', async ({ page }) => {
  await mockApi(page, { macro: 'unavailable' });
  await page.goto('/swing');
  await expect(page.locator('#light-title')).toContainText('economic calendar is unavailable');
  await expect(page.locator('#light-why')).toContainText('UNAVAILABLE');
});

test('the ten-year replay is on the Swing page with its chart and honest headline', async ({ page }) => {
  await mockApi(page);
  await page.goto('/swing');
  await expect(page.locator('.rp-verdict')).toContainText('Holding the S&P 500');
  await expect(page.locator('#replay svg path')).toHaveCount(2);
  await page.locator('#replay .hit').hover({ position: { x: 200, y: 60 } });
  await expect(page.locator('.rp-tip')).toContainText('S&P 500');
});

test('sync: set up on one device, join on another, and the data arrives', async ({ browser }) => {
  const PASS = `e2e-${Date.now()}-passphrase`;
  const A = await browser.newContext(), B = await browser.newContext();
  const a = await A.newPage(), b = await B.newPage();
  await mockApi(a); await mockApi(b);
  await a.addInitScript(() => { if (!localStorage.getItem('sd-portfolio-v1')) localStorage.setItem('sd-portfolio-v1', JSON.stringify([{ id: 'DIS-e2e', ticker: 'DIS', qty: 3, buyPrice: 118, buyDate: '2026-11-18', stop: 112, assetClass: 'stock' }])); });
  await a.goto('/dashboard');
  await expect(a.locator('#sync-state')).toHaveText('Off');
  await a.locator('#sync-setup').click();
  await answerDialog(a, PASS); await answerDialog(a, PASS);
  const codeBox = a.locator('dialog[open] textarea, dialog[open] input').first();
  await expect(codeBox).toHaveValue(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  const code = await codeBox.inputValue();
  await a.locator('dialog[open] button.ok').click();
  await expect(a.locator('#sync-state')).toHaveText('On');

  await b.goto('/dashboard');
  await expect(b.locator('.pos-card')).toHaveCount(0);
  await b.locator('#sync-join').click();
  await answerDialog(b, code); await answerDialog(b, 'not-the-passphrase');
  expect(await answerDialog(b)).toContain('Wrong passphrase');
  await b.locator('#sync-join').click();
  await answerDialog(b, code.toLowerCase()); await answerDialog(b, PASS);
  await expect(b.locator('.pos-card', { hasText: 'DIS' })).toBeVisible();
  await expect(b.locator('#sync-state')).toHaveText('On');

  // a change on B reaches A the next time A opens a page
  await b.evaluate(() => localStorage.setItem('sd-capital', '4321'));
  await b.locator('#sync-now').click();
  await expect(b.locator('#sync-state')).toHaveText('In step');
  await a.reload();
  await expect.poll(() => a.evaluate(() => localStorage.getItem('sd-capital'))).toBe('4321');

  await a.locator('#sync-wipe').click(); await answerDialog(a);
  await expect(a.locator('#sync-state')).toHaveText('Off');
  await A.close(); await B.close();
});
