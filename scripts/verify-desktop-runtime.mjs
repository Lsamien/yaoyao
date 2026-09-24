import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {verifyRuntimePackage} from '../bin/lib/runtime-release.mjs'

/** Run before signing: a valid build directory does not prove extraResources
 * retained the Runner's external packages in the actual application. */
export function verifyDesktopRuntime(runtime,version){
  const service=join(runtime,'web-service'),identity=verifyRuntimePackage(service)
  const probe=String.raw`
    import {createRequire} from 'node:module';
    import {readFileSync,realpathSync,statSync} from 'node:fs';
    import {dirname,join,relative,isAbsolute} from 'node:path';
    import {pathToFileURL} from 'node:url';
    const {runtime,version}=JSON.parse(process.argv[1]);
    for(const [base,entry] of [[runtime,'runner.mjs'],[join(runtime,'web-service'),'server.mjs']]){
      if(!statSync(join(base,entry)).isFile())throw new Error('应用内执行入口缺失：'+entry);
      const require=createRequire(join(base,entry));
      for(const name of ['playwright','playwright-core']){
        const path=realpathSync(require.resolve(name+'/package.json'));
        const local=relative(realpathSync(join(base,'node_modules',name)),path);
        if(local.startsWith('..')||isAbsolute(local))throw new Error('浏览器依赖解析到了应用外部：'+name);
        const pkg=JSON.parse(readFileSync(path,'utf8'));
        if(pkg.version!==version)throw new Error('浏览器运行包版本不一致：'+name);
        if(name==='playwright'){
          const {chromium}=await import(pathToFileURL(join(dirname(path),'index.mjs')).href);
          if(!chromium?.executablePath())throw new Error('浏览器运行包无法加载');
        }else if(!JSON.parse(readFileSync(join(dirname(path),'browsers.json'),'utf8')).browsers?.length){
          throw new Error('浏览器运行包缺少安装清单');
        }
      }
    }
  `
  execFileSync(join(service,'node'),['--input-type=module','-e',probe,JSON.stringify({runtime,version})],{cwd:runtime,stdio:['ignore','pipe','pipe'],timeout:30000})
  return identity
}

export default async function verifyPackagedDesktop(context){
  if(context.electronPlatformName!=='darwin')return
  const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).dependencies.playwright
  const runtime=join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents','Resources','runtime')
  verifyDesktopRuntime(runtime,version)
  console.log('签名前验证通过：应用内 Runner / Web 浏览器依赖与服务完整性。')
}
