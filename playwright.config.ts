import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3101', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '3101',
      HOST: '127.0.0.1',
      DATABASE_PATH: './data/e2e.sqlite',
      THREAD_DEMO_ONLY: 'true',
    },
  },
});
