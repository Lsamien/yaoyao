import {defineConfig,devices} from '@playwright/test'
export default defineConfig({
 testDir:'./tests/e2e',testMatch:'bot-panels.spec.ts',workers:1,timeout:60000,reporter:'list',
 use:{baseURL:'http://127.0.0.1:18832',viewport:{width:1440,height:900},trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
 webServer:{command:'WORKSPACE_FIXTURE_PORT=18832 WORKSPACE_FIXTURE_UPSTREAM_PORT=19132 node --import tsx tests/fixtures/workspace-server.ts',url:'http://127.0.0.1:18832/healthz',reuseExistingServer:false,timeout:60000},
})
