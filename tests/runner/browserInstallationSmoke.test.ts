// @vitest-environment node
import {expect,it} from 'vitest'
import {execFile} from 'node:child_process'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {promisify} from 'node:util'

/** Opt-in real first-install test. It downloads the pinned Chromium into a fresh
 * temporary cache in a separate Node process, then removes that cache.
 * YAOYAO_BROWSER_INSTALL_SMOKE=1 npx vitest run tests/runner/browserInstallationSmoke.test.ts */
it.skipIf(process.env.YAOYAO_BROWSER_INSTALL_SMOKE!=='1')('prepares an empty node browser cache, downloads Chromium and opens a sandboxed Runner session',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-browser-install-smoke-')))
  const require=createRequire(import.meta.url)
  const script=`
    import {randomUUID} from 'node:crypto';
    import {existsSync} from 'node:fs';
    import {join} from 'node:path';
    import {RunnerBrowser} from ${JSON.stringify(pathToFileURL(resolve('src/runner/managedBrowser.ts')).href)};
    import {createBrowserInstaller} from ${JSON.stringify(pathToFileURL(resolve('src/runner/browser/installation.ts')).href)};
    const report=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    const installer=createBrowserInstaller();
    const originalInstall=installer.install;
    installer.install=options=>originalInstall({...options,onUpdate:update=>{report({event:'progress',...update});options.onUpdate(update)}});
    const grants=new Map();
    const check=async(_scope,id)=>{if(id?grants.has(id):[...grants.values()].some(role=>role!=='prepare'))return;throw new Error('browser session has no active grant')};
    const browser=new RunnerBrowser({enabled:true},process.env.YAOYAO_INSTALL_SMOKE_HOME,check,{installer});
    process.once('SIGTERM',()=>void browser.shutdown().finally(()=>process.exit(1)));
    const scope={ownerKey:'a'.repeat(64),environmentId:randomUUID(),profile:'temporary'},setupGrant=randomUUID(),taskGrant=randomUUID();
    const invoke=async(op,extra={})=>{
      const role=op==='status'?'view':op==='prepare'?'prepare':'task',grantId=role==='view'?randomUUID():role==='prepare'?setupGrant:taskGrant;
      grants.set(grantId,role);
      try{return await browser.invoke({scope,profile:'default',grantId,op,...extra},Date.now()+30000,()=>{})}
      finally{if(role==='view')grants.delete(grantId)}
    };
    try {
      await browser.ready;
      if(browser.available||existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH))throw new Error('fixture cache is not empty');
      report({event:'initial',...await invoke('status')});
      report({event:'prepared',...await invoke('prepare')});
      let state;
      for(;;){
        state=await invoke('status');
        if(state.installation.status==='ready')break;
        if(state.installation.status==='failed')throw new Error(state.installation.message);
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      grants.delete(setupGrant);
      if(!await installer.probe())throw new Error('post-install sandbox probe failed');
      const opened=await invoke('open');
      const frame=await invoke('execute',{operation:{generation:opened.generation,operationId:'installation-smoke',action:{kind:'screenshot'}}});
      if(Buffer.from(frame.data,'base64').subarray(1,4).toString()!=='PNG')throw new Error('missing browser frame');
      const {chromium}=await import('playwright');
      report({event:'ready',available:state.available,status:state.installation.status,open:opened.open,mimeType:frame.mimeType,executableInTemporaryCache:chromium.executablePath().startsWith(process.env.PLAYWRIGHT_BROWSERS_PATH)});
      await invoke('close');
    }finally{await browser.shutdown()}
  `
  try{
    const {stdout}=await promisify(execFile)(process.execPath,['--import',require.resolve('tsx'),'--input-type=module','--eval',script],{
      cwd:resolve('.'),env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:join(root,'browsers'),YAOYAO_INSTALL_SMOKE_HOME:join(root,'runner'),ELECTRON_RUN_AS_NODE:'1'},timeout:9*60000,maxBuffer:1024*1024,
    })
    const events=stdout.trim().split('\n').map(line=>JSON.parse(line))
    expect(events.find(event=>event.event==='initial')).toMatchObject({available:false,installation:{status:'missing'}})
    expect(events.find(event=>event.event==='prepared')).toMatchObject({available:false,installation:{status:'installing'}})
    expect(events.filter(event=>event.event==='progress').map(event=>event.message)).toContain('正在验证 Chromium 沙箱启动')
    expect(events.find(event=>event.event==='ready')).toMatchObject({available:true,status:'ready',open:true,mimeType:'image/png',executableInTemporaryCache:true})
    // Keep the evidence useful without exposing the temporary cache's personal path.
    console.info('fresh-install smoke evidence:',JSON.stringify(events.filter(event=>['progress','ready'].includes(event.event))))
  }finally{await rm(root,{recursive:true,force:true})}
},10*60000)
