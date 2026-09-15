// @vitest-environment node
import {expect,it} from 'vitest'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID,randomBytes,scryptSync} from 'node:crypto'

const command=promisify(execFile),image=process.env.YAOYAO_DOCKER_BRIDGE_IMAGE
const docker=async(...args:string[])=>(await command('docker',args,{timeout:90000,maxBuffer:2*1024*1024})).stdout.trim()
it.skipIf(!image)('installs bridges into mapped Hermes storage through the real non-root, read-only Docker Web',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yaoyao-docker-bridge-')),hermes=join(root,'hermes')
  const id='yaoyao-bridge-'+randomUUID().slice(0,8),web=id+'-web',upstream=id+'-hermes',network=id+'-net',volume=id+'-data'
  const original=JSON.stringify({model:{default:'fixture-model'},notes:'preserve-default',plugins:{enabled:['existing']}})
  await chmod(root,0o755);await mkdir(join(hermes,'profiles','writer'),{recursive:true})
  // Disposable fixture permissions allow the image's uid 1000 to write; never
  // change permissions on the user's real Hermes directory.
  for(const path of [hermes,join(hermes,'profiles'),join(hermes,'profiles','writer')])await chmod(path,0o777)
  await writeFile(join(hermes,'config.yaml'),original,{mode:0o666});await chmod(join(hermes,'config.yaml'),0o666)
  await writeFile(join(hermes,'profiles','writer','config.yaml'),JSON.stringify({notes:'preserve-writer',plugins:{disabled:['yaoyao-bot-bridge']}}),{mode:0o666})
  await chmod(join(hermes,'profiles','writer','config.yaml'),0o666)
  const salt=randomBytes(16),now=Date.now()
  await writeFile(join(root,'users.json'),JSON.stringify({version:1,users:[{id:randomUUID(),username:'fixture',normalizedUsername:'fixture',role:'admin',enabled:true,mustChangePassword:false,salt:salt.toString('base64'),passwordHash:scryptSync('fixture-pass',salt,32,{N:2**14,r:8,p:1,maxmem:64*1024*1024}).toString('base64'),authVersion:1,createdAt:now,updatedAt:now}]}))
  await writeFile(join(root,'upstream.mjs'),`import {createServer} from 'node:http';const calls=[];createServer((req,res)=>{const path=new URL(req.url,'http://hermes').pathname;calls.push({path,method:req.method});res.setHeader('Content-Type','application/json');let value={ok:true};if(path==='/api/status')value={auth_required:true,gateway_running:true};if(path==='/auth/password-login')res.setHeader('Set-Cookie','hermes_session_at=fixture; Path=/; HttpOnly');if(path==='/api/auth/me')value={user_id:'fixture'};if(path==='/api/profiles')value={profiles:[{name:'default'},{name:'writer'}]};if(path.endsWith('/capabilities'))value={version:1,ready:false,in_process:true};if(path==='/__calls')value=calls;res.end(JSON.stringify(value))}).listen(9119,'0.0.0.0');`)
  const cookies=new Map<string,string>();let csrf=''
  try{
    for(const base of ['compose.yaml','compose.desktops.yaml','compose.desktops.cursor.yaml']){
      const output=await command('docker',['compose','--env-file','/dev/null','-f',base,'-f','compose.hermes-bridge.yaml','config','--format','json'],{env:{...process.env,HERMES_YAOYAO_HERMES_DIR:hermes},maxBuffer:2*1024*1024})
      const config=JSON.parse(output.stdout),service=config.services.web
      expect(service.read_only).toBe(true);expect(service.cap_drop).toEqual(['ALL'])
      expect(service.environment.HERMES_YAOYAO_LOCAL_VM_HOST).toBe('runner')
      expect(service.environment.HERMES_YAOYAO_SUPERVISE_DASHBOARD).toBe('0')
      expect(service.volumes.find((v:any)=>v.target==='/hermes')).toMatchObject({type:'bind',source:hermes,bind:{create_host_path:false}})
      expect(JSON.stringify(service.volumes)).not.toContain('docker.sock')
    }
    await docker('network','create',network);await docker('volume','create',volume)
    await docker('run','--rm','--network','none','--mount',`type=volume,src=${volume},dst=/home/node/.yaoyao`,'--mount',`type=bind,src=${root},dst=/fixture,readonly`,'--entrypoint','node',image!,'-e',"require('fs').copyFileSync('/fixture/users.json','/home/node/.yaoyao/users.json')")
    await docker('run','-d','--name',upstream,'--network',network,'--network-alias','hermes','--no-healthcheck','--mount',`type=bind,src=${root},dst=/fixture,readonly`,image!,'node','/fixture/upstream.mjs')
    await docker('run','-d','--name',web,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:mode=1777','-p','127.0.0.1::15300',
      '--mount',`type=volume,src=${volume},dst=/home/node/.yaoyao`,'--mount',`type=bind,src=${hermes},dst=/hermes`,
      '-e','HERMES_YAOYAO_UPSTREAM=http://hermes:9119','-e','HERMES_YAOYAO_UPSTREAM_USERNAME=fixture','-e','HERMES_YAOYAO_UPSTREAM_PASSWORD=fixture','-e','HERMES_YAOYAO_ALLOW_INSECURE_LAN=1','-e','HERMES_YAOYAO_ALLOWED_HOSTS=127.0.0.1,localhost',
      '-e','HERMES_YAOYAO_BRIDGE_MOUNTED=1','-e','HERMES_YAOYAO_BRIDGE_HOME=/hermes','-e','HERMES_YAOYAO_BRIDGE_PYTHON=/usr/bin/python3',image!)
    const port=(await docker('port',web,'15300/tcp')).split(':').at(-1)!,origin='http://127.0.0.1:'+port
    const api=async(path:string,body?:unknown,expected=200)=>{
      const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),...(csrf?{'X-CSRF-Token':csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})
      for(const header of response.headers.getSetCookie()){const item=header.split(';')[0],equals=item.indexOf('=');cookies.set(item.slice(0,equals),item.slice(equals+1))}
      const text=await response.text();expect(response.status,text).toBe(expected);return JSON.parse(text)
    }
    await expect.poll(async()=>{try{return(await fetch(origin+'/healthz')).status}catch{return 0}},{timeout:30000}).toBe(200)
    await api('/auth/password-login',{username:'fixture',password:'fixture-pass'})
    csrf=(await api('/api/app/bootstrap?csrfOnly=1')).csrfToken
    const before=await api('/api/app/admin/hermes-bridge')
    expect(before.mapped).toBe(true);expect(before.local).toBe(true);expect(before.profiles[0].canInstall).toBe(true)
    expect(before.profiles[0].state).toBe('missing')
    await api('/api/app/admin/hermes-bridge/install',{profile:'writer',enable:true},409)
    const installed=await api('/api/app/admin/hermes-bridge/install',{profile:'default',enable:true})
    expect(installed.status.profiles[0].state).toBe('restart-required')
    const backup=join(hermes,installed.backup.slice('/hermes/'.length),'config.yaml')
    expect(await readFile(backup,'utf8')).toBe(original)
    expect(await readFile(join(hermes,'config.yaml'),'utf8')).toContain('preserve-default')
    expect(await readFile(join(hermes,'plugins','yaoyao-bot-bridge','bridge_runtime.py'),'utf8')).toContain('computer_runtime_version')
    await api('/api/app/admin/hermes-bridge/install',{profile:'writer',enable:true})
    expect(await readFile(join(hermes,'profiles','writer','config.yaml'),'utf8')).toContain('preserve-writer')
    expect((await stat(join(hermes,'profiles','writer','plugins','yaoyao-bot-bridge','plugin.yaml'))).isFile()).toBe(true)
    expect(await docker('exec',web,'id','-u')).toBe('1000')
    expect(await docker('exec',web,'python3','-c','import yaml;print("yaml-ready")')).toBe('yaml-ready')
    expect(await docker('inspect','--format','{{.HostConfig.ReadonlyRootfs}}',web)).toBe('true')
    const calls=JSON.parse(await docker('exec',web,'node','-e',"fetch('http://hermes:9119/__calls').then(r=>r.text()).then(console.log)"))
    expect(calls.some((c:any)=>/restart|stop|gateway\/start/.test(c.path))).toBe(false)
  }catch(error){try{console.error((await docker('logs','--tail','35',web)).slice(-6000))}catch{}throw error}
  finally{
    await docker('rm','-f',web,upstream).catch(()=>{})
    await docker('volume','rm',volume).catch(()=>{});await docker('network','rm',network).catch(()=>{})
    await rm(root,{recursive:true,force:true})
  }
},120000)
