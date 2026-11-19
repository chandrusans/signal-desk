// Browser tests: `npm run e2e`. They drive the real pages served by tools/devserver.mjs, with every
// market-data call answered from e2e/fixtures.mjs (made-up, deterministic numbers), so a run needs
// no network and cannot be broken by a data source having a bad day. Sync uses the real
// /api/vault handler over a scratch folder.
import { defineConfig } from '@playwright/test';

const PORT = 3100;
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.mjs/,
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1280, height: 900 } },
  webServer: { command: `node tools/devserver.mjs ${PORT}`, url: `http://localhost:${PORT}/terms`, reuseExistingServer: !process.env.CI, env: { SD_VAULT_DIR: '.cache/vault-e2e' } },
});
