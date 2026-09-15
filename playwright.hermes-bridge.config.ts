import {defineConfig,devices} from '@playwright/test'
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',')
process.env.no_proxy=[process.env.no_proxy,'127.0.0.1','localhost'].filter(Boolean).join(',')
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'hermes-bridge.spec.ts',workers:1,timeout:60000,reporter:'list',
  use:{baseURL:'http://127.0.0.1:18835',viewport:{width:1440,height:1000},trace:'retain-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000}}}],
  webServer:{command:'WORKSPACE_FIXTURE_PORT=18835 WORKSPACE_FIXTURE_UPSTREAM_PORT=19135 node --import tsx tests/fixtures/workspace-server.ts',url:'http://127.0.0.1:18835/healthz',reuseExistingServer:false,timeout:60000},
})
