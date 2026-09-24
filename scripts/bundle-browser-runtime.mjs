import {cp,mkdir,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join,relative,sep} from 'node:path'

export const browserRuntimeExternals=['playwright','playwright-core']

/** Playwright loads assets relative to its package directory and cannot be
 * flattened by esbuild. Copy its runtime packages, never browser binaries or
 * user profiles. Chromium is explicitly installed on the destination host. */
export async function bundleBrowserRuntime(directory){
  const require=createRequire(import.meta.url),modules=join(directory,'node_modules')
  await mkdir(modules,{recursive:true})
  for(const name of browserRuntimeExternals){
    const source=dirname(require.resolve(`${name}/package.json`)),target=join(modules,name)
    await rm(target,{recursive:true,force:true})
    await cp(source,target,{recursive:true,filter:path=>!relative(source,path).split(sep).includes('.local-browsers')})
  }
}
