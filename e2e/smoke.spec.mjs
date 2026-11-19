import { test, expect } from '@playwright/test';
import { mockApi, watchErrors } from './fixtures.mjs';

const PAGES = [['/today', 'Today'], ['/swing', 'Swing'], ['/dashboard', 'Dashboard'], ['/alerts', 'Alerts'], ['/research', 'Research'], ['/', 'Momentum'], ['/options', 'Options'], ['/crypto', 'Crypto'], ['/metals', 'Metals'], ['/simulate', 'Simulate'], ['/handbook', 'Handbook'], ['/privacy', 'Privacy'], ['/terms', 'Terms']];

for (const [path, title] of PAGES) {
  test(`${path} loads with no script errors`, async ({ page }) => {
    const errors = watchErrors(page);
    await mockApi(page);
    await page.goto(path);
    await expect(page).toHaveTitle(new RegExp(title));
    await page.waitForTimeout(1500);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll').toBe(true);
  });
}

test('the navigation bar: five primary tabs, the rest under More, and it sticks while scrolling', async ({ page }) => {
  await mockApi(page);
  await page.goto('/today');
  const primary = page.locator('.tabbar-tabs > a.tab');
  await expect(primary).toHaveText(['Today', 'Swing', 'Dashboard', 'Alerts', 'Research']);
  await expect(page.locator('.more-menu')).toBeHidden();
  await page.locator('.more-btn').click();
  await expect(page.locator('.more-menu a')).toHaveText(['Stocks', 'Options', 'Crypto', 'Metals', 'Simulate']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.more-menu')).toBeHidden();
  await page.locator('.more-btn').click();
  await page.locator('.more-menu a', { hasText: 'Metals' }).click();
  await expect(page).toHaveURL(/\/metals$/);
  await expect(page.locator('.more-btn')).toHaveText('Metals');
  await page.mouse.wheel(0, 1200);
  await expect(page.locator('.tabbar')).toBeInViewport();
});

test('on a phone every destination is in the scrolling row and the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockApi(page);
  await page.goto('/crypto');
  await expect(page.locator('.more-btn')).toBeHidden();
  await expect(page.locator('.tabbar-tabs a.tab')).toHaveCount(10);
  await expect(page.locator('.tabbar-tabs a.tab.on')).toBeInViewport();
});

test('privacy and terms are linked from the foot of a page and say they are drafts', async ({ page }) => {
  await mockApi(page);
  await page.goto('/today');
  await page.locator('.legal-links a', { hasText: 'Privacy' }).click();
  await expect(page.locator('.draft')).toContainText('has not been reviewed by a lawyer');
  await page.locator('.legal-foot a', { hasText: 'Terms' }).click();
  await expect(page.locator('main')).toContainText('It is not investment advice');
});
