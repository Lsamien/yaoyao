import { build } from 'esbuild'
import { mkdir,copyFile,cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildRunner(directory = resolve(import.meta.dirname, '../.runner-build')) {
  await mkdir(directory, { recursive: true })
  await copyFile(resolve(import.meta.dirname,'../src/runner/worker/hermes_worker.py'),resolve(directory,'hermes_worker.py'))
  await copyFile(resolve(import.meta.dirname,'../src/runner/network/guest_proxy.py'),resolve(directory,'guest_proxy.py'))
  await cp(resolve(import.meta.dirname,'../deploy/computer'),resolve(directory,'computer-image'),{recursive:true})
  await cp(resolve(import.meta.dirname,'../third-party'),resolve(directory,'third-party'),{recursive:true})
  await build({
    entryPoints: { 'runner-maintenance':resolve(import.meta.dirname, '../src/runner/computers/maintenanceCli.ts'), 'runner-image':resolve(import.meta.dirname, '../src/runner/computers/imageCli.ts'), runner:resolve(import.meta.dirname, '../src/runner/index.ts'), 'runner-config':resolve(import.meta.dirname, '../src/runner/config.ts') },
    outdir:directory, outExtension:{'.js':'.mjs'}, bundle: true, platform: 'node',
    format: 'esm', target: 'node24', sourcemap: true,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRunner()
  console.log('执行节点已打包到 .runner-build/runner.mjs（需要 Node.js 24 或更高版本）')
}
