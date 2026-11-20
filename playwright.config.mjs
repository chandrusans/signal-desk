// Browser tests: `npm run e2e`. They drive the real pages served by tools/devserver.mjs, with every
// market-data call answered from e2e/fixtures.mjs (made-up, deterministic numbers), so a run needs
// no network and cannot be broken by a data source having a bad day. Sync uses the real
// /api/vault handler over a scratch folder.
import { defineConfig } from '@playwright/test';

const PORT = 3100;
// A second copy of the dev server with the app lock switched on (e2e/lock.spec.mjs). The password and
// owner key below exist only for these tests, on this machine.
export const LOCKED_PORT = 3101;
export const LOCK_TEST = { password: 'e2e-only-lock-password', ownerKey: 'e2e-only-owner-key' };
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.mjs/,
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1280, height: 900 } },
  webServer: [
    { command: `node tools/devserver.mjs ${PORT}`, url: `http://localhost:${PORT}/terms`, reuseExistingServer: !process.env.CI, env: { SD_VAULT_DIR: '.cache/vault-e2e', APP_PASSWORD: '' } },
    { command: `node tools/devserver.mjs ${LOCKED_PORT}`, url: `http://localhost:${LOCKED_PORT}/terms`, reuseExistingServer: !process.env.CI, env: { SD_VAULT_DIR: '.cache/vault-e2e-locked', APP_PASSWORD: LOCK_TEST.password, RUN_KEY: LOCK_TEST.ownerKey } },
  ],
});
