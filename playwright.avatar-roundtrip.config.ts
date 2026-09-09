import {defineConfig,devices} from '@playwright/test'
// The explicit three-client acceptance chain uses the already running disposable fixture.
export default defineConfig({testDir:'./tests/e2e',outputDir:'test-results/avatar-roundtrip',testMatch:'avatarRoundTrip.spec.ts',workers:1,timeout:30000,reporter:'list',use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:18804',viewport:{width:1200,height:850}}})
