import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // These suites own different fixtures and run with their dedicated configurations.
  testIgnore: ['**/workspace-chat.spec.ts', '**/team-tools.spec.ts', '**/avatarReference.spec.ts', '**/avatarRoundTrip.spec.ts', '**/serverIdentity.spec.ts', '**/bot-panels.spec.ts', '**/grok-auth.spec.ts', '**/native-environment.spec.ts'],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18801',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node tests/fixtures/fake-hermes.mjs',
      port: 19119,
      reuseExistingServer: true,
      timeout: 15_000,
    },
    {
      command: 'node tests/fixtures/e2e-web-server.mjs',
      url: 'http://127.0.0.1:18801/healthz',
      reuseExistingServer: true,
      timeout: 15_000,
    },
  ],
})
