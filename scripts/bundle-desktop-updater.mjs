import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchMacUpdater } from './patch-mac-updater.mjs'

const require = createRequire(import.meta.url)
export async function bundleDesktopUpdater(outfile, platform = process.platform) {
  await build({ entryPoints: [require.resolve('electron-updater')], outfile,
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], legalComments: 'eof' })
  // Pin electron-updater and fail the build if its native staging code changes.
  if (platform === 'darwin') await writeFile(outfile, patchMacUpdater(await readFile(outfile, 'utf8')))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await bundleDesktopUpdater(resolve(import.meta.dirname, '../.desktop-build/electron-updater.cjs'))
