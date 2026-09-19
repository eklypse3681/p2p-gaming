import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a real `dealer serve` process over the in-memory transport (see e2e/global-setup.ts),
 * so no network and no PeerJS cloud are involved.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.CONSOLE_URL ?? 'http://127.0.0.1:7791/',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
