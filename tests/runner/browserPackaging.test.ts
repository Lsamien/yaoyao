// @vitest-environment node
import {expect,it} from 'vitest'
import {build} from 'esbuild'
import {mkdtemp,rm,readdir,readFile,copyFile,mkdir,writeFile,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {load} from 'js-yaml'
// @ts-expect-error Build helper is plain JavaScript.
import {browserRuntimeExternals,bundleBrowserRuntime} from '../../scripts/bundle-browser-runtime.mjs'
// @ts-expect-error Build verification helper is plain JavaScript.
import {verifyDesktopRuntime} from '../../scripts/verify-desktop-runtime.mjs'
// @ts-expect-error Sealed runtime helper is plain JavaScript.
import {sealRuntime} from '../../bin/lib/runtime-release.mjs'

it('imports Playwright from electron-builder copied Runner and Web resources without repository dependencies or Chromium caches',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yaoyao-browser-package-'))
  try{
    const staging=join(directory,'.desktop-build'),resources=join(directory,'packaged-app','Contents','Resources')
    await build({stdin:{contents:'const {chromium}=await import("playwright"); console.log(JSON.stringify({path:chromium.executablePath(),version:(await import("playwright/package.json",{with:{type:"json"}})).default.version,resolved:import.meta.resolve("playwright")}))',resolveDir:process.cwd(),sourcefile:'browser-probe.mjs'},outfile:join(staging,'runner.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',external:browserRuntimeExternals})
    await bundleBrowserRuntime(staging)
    const service=join(staging,'web-service')
    await bundleBrowserRuntime(service)
    await copyFile(join(staging,'runner.mjs'),join(service,'server.mjs'))
    // A minimal sealed service fixture uses the real Node binary and browser
    // packages; it does not depend on a developer's previous desktop build.
    await copyFile(process.execPath,join(service,'node'));await chmod(join(service,'node'),0o755)
    await mkdir(join(service,'ui'));await writeFile(join(service,'ui/index.html'),'<!doctype html>Fixture')
    await mkdir(join(service,'bin'))
    for(const name of ['hermes-yaoyao.mjs','hermes-yaoyao-updater.mjs'])await writeFile(join(service,'bin',name),'// packaging fixture\n')
    await writeFile(join(service,'build-info.json'),JSON.stringify({commit:'packaging-fixture',ancestors:[],buildNumber:1,dirty:false}))
    await writeFile(join(service,'release.json'),JSON.stringify({webVersion:'0.0.1',releaseVersion:'0.0.1',gitTag:'v0.0.1'}))
    sealRuntime(service)
    const configuration=load(await readFile(new URL('../../electron-builder.yml',import.meta.url),'utf8'))
    // Exercise the real packaging walker, which intentionally skips a source's
    // root node_modules. Plain glob matching did not catch the missing packages.
    const {getFileMatchers,copyFiles}=createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js')
    const matchers=getFileMatchers(configuration,'extraResources',resources,{defaultSrc:directory,macroExpander:(value:string)=>value,customBuildOptions:{},globalOutDir:join(directory,'desktop-release')})
    await copyFiles(matchers)
    const manifest=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'))
    for(const [relative,entry] of [['runtime','runner.mjs'],['runtime/web-service','server.mjs']]){
      const runtime=join(resources,relative!),result=JSON.parse(execFileSync(process.execPath,[join(runtime,entry!)],{cwd:directory,encoding:'utf8'}))
      expect(result.version).toBe(manifest.dependencies.playwright);expect(result.path).toContain('chromium')
      expect(result.resolved).toContain('/packaged-app/Contents/Resources/'+relative+'/node_modules/playwright/')
      expect(await readdir(join(runtime,'node_modules'))).toEqual(['playwright','playwright-core'])
      expect(await readdir(join(runtime,'node_modules','playwright-core'))).not.toContain('.local-browsers')
      expect(JSON.parse(await readFile(join(runtime,'node_modules/playwright-core/browsers.json'),'utf8')).browsers.some((browser:{name:string})=>browser.name==='chromium')).toBe(true)
    }
    const packagedRuntime=join(resources,'runtime')
    expect(verifyDesktopRuntime(packagedRuntime,manifest.dependencies.playwright)).toMatchObject({commit:'packaging-fixture',version:'0.0.1',dirty:false})
    await rm(join(packagedRuntime,'node_modules','playwright'),{recursive:true,force:true})
    expect(()=>verifyDesktopRuntime(packagedRuntime,manifest.dependencies.playwright)).toThrow()
  }finally{await rm(directory,{recursive:true,force:true})}
},20000)
