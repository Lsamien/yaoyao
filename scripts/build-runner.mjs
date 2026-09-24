import { build } from 'esbuild'
import { mkdir,copyFile,cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {browserRuntimeExternals,bundleBrowserRuntime} from './bundle-browser-runtime.mjs'

export async function buildRunner(directory = resolve(import.meta.dirname, '../.runner-build')) {
  await mkdir(directory, { recursive: true })
  await cp(resolve(import.meta.dirname,'../integrations/hermes-bots-bridge'),resolve(directory,'hermes-bots-bridge'),{recursive:true,filter:source=>!source.includes('__pycache__')&&!source.endsWith('.pyc')&&!source.includes('/tests')})
  await copyFile(resolve(import.meta.dirname,'install-hermes-bridge.py'),resolve(directory,'install-hermes-bridge.py'))
  await copyFile(resolve(import.meta.dirname,'../src/runner/worker/hermes_worker.py'),resolve(directory,'hermes_worker.py'))
  await copyFile(resolve(import.meta.dirname,'../src/runner/worker/profile_skills.py'),resolve(directory,'profile_skills.py'))
  await copyFile(resolve(import.meta.dirname,'../deploy/computer/skill_bundle.py'),resolve(directory,'skill_bundle.py'))
  await copyFile(resolve(import.meta.dirname,'../src/runner/network/guest_proxy.py'),resolve(directory,'guest_proxy.py'))
  await cp(resolve(import.meta.dirname,'../deploy/computer'),resolve(directory,'computer-image'),{recursive:true})
  await cp(resolve(import.meta.dirname,'../third-party'),resolve(directory,'third-party'),{recursive:true})
  await build({
    entryPoints: { 'runner-maintenance':resolve(import.meta.dirname, '../src/runner/computers/maintenanceCli.ts'), 'runner-image':resolve(import.meta.dirname, '../src/runner/computers/imageCli.ts'), runner:resolve(import.meta.dirname, '../src/runner/index.ts'), 'runner-config':resolve(import.meta.dirname, '../src/runner/config.ts') },
    outdir:directory, outExtension:{'.js':'.mjs'}, bundle: true, platform: 'node',
    format: 'esm', target: 'node24', sourcemap: true,external:browserRuntimeExternals,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  })
  await bundleBrowserRuntime(directory)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRunner()
  console.log('执行节点已打包到 .runner-build/runner.mjs（需要 Node.js 24 或更高版本）')
  console.log('启用托管浏览器前，在目标主机运行 node .runner-build/node_modules/playwright/cli.js install chromium；Linux 还需 install-deps chromium。')
}
