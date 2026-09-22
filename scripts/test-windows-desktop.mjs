import { execFileSync } from 'node:child_process'
const files = ['platform', 'windows', 'windows-smoke', 'onboarding', 'onboarding-renderer', 'host-files', 'host-manager', 'host-environment',
  'preferences', 'remote-login', 'auto-update-manager', 'update-manager']
execFileSync(process.execPath, ['--test', ...files.map(name => `desktop/${name}.test.mjs`)], { stdio: 'inherit' })
