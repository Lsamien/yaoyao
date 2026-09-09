import {defineConfig,devices} from '@playwright/test'
export default defineConfig({testDir:'./tests/e2e',testMatch:'serverIdentity.spec.ts',outputDir:'test-results/server-name',workers:1,timeout:30000,reporter:'list',use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:18804',viewport:{width:1100,height:850}}})
