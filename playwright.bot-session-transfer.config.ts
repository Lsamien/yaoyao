import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'bot-session-transfer.spec.ts', workers: 1, timeout: 60000, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:18842', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'WORKSPACE_FIXTURE_PORT=18842 WORKSPACE_FIXTURE_UPSTREAM_PORT=19142 node --import tsx tests/fixtures/workspace-server.ts', url: 'http://127.0.0.1:18842/healthz', reuseExistingServer: false, timeout: 60000 },
})
