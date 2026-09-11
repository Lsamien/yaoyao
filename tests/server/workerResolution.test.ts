// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir,homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {HermesWorkerProcess} from '../../src/runner/worker/process'

let root:string,source:string,home:string
const workers:HermesWorkerProcess[]=[]
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'yaoyao-resolver-'));source=join(root,'source');home=join(root,'profile')
 await mkdir(join(source,'hermes_cli'),{recursive:true});await mkdir(home)
 // Only replace the installed Hermes config/SDK boundary. Exercise the real
 // Python reader and Node protocol, including failures and secret filtering.
 await writeFile(join(source,'dotenv.py'),'import json\ndef dotenv_values(path): return json.loads(path.read_text()) if path.exists() else {}\n')
 await writeFile(join(source,'hermes_constants.py'),'def set_hermes_home_override(path): pass\n')
 await writeFile(join(source,'hermes_cli','config.py'),'import os,json\nfrom pathlib import Path\ndef load_config_readonly(): return json.loads((Path(os.environ["HERMES_HOME"])/"config.yaml").read_text())\n')
 await writeFile(join(source,'hermes_cli','runtime_provider.py'),'raise RuntimeError("provider secret must never escape")\n')
})
afterEach(async()=>{await Promise.all(workers.splice(0).map(w=>w.close()));vi.unstubAllEnvs();await rm(root,{recursive:true,force:true})})
function read(mode='resolve-workspace',profile='default'){
 const worker=new HermesWorkerProcess('python3',resolve('src/runner/worker/hermes_worker.py'),{mode,profile,hermesSource:source,hermesHome:home})
 workers.push(worker);return worker.wait('resolved')
}
it.each([
 ['.','/home/cua/workspace'],['auto','/home/cua/workspace'],['cwd','/home/cua/workspace'],
 ['projects/demo','/home/cua/workspace/projects/demo'],['/projects/demo','/projects/demo'],['~/projects',join(homedir(),'projects')],
])('resolves %s without importing the model SDK',async(configured,cwd)=>{
 await writeFile(join(home,'config.yaml'),JSON.stringify({terminal:{cwd:configured}}))
 expect(await read()).toMatchObject({cwd,configuredCwd:configured})
})
it('handles default/missing cwd and named Profiles without mixing Profile settings',async()=>{
 await writeFile(join(home,'config.yaml'),'{}')
 expect(await read()).toMatchObject({cwd:'/home/cua/workspace',configuredCwd:'.'})
 await mkdir(join(home,'profiles','writer'),{recursive:true})
 await writeFile(join(home,'profiles','writer','config.yaml'),JSON.stringify({terminal:{cwd:'/projects/writer'}}))
 expect(await read('resolve-workspace','writer')).toMatchObject({cwd:'/projects/writer'})
})
it('reports directory and Profile errors without mislabelling them as model errors',async()=>{
 for(const cwd of ['../../escape','\u0000',32]){
  await writeFile(join(home,'config.yaml'),JSON.stringify({terminal:{cwd}}))
  await expect(read()).rejects.toMatchObject({code:'computer_cwd_invalid'})
 }
 await expect(read('resolve-workspace','missing')).rejects.toMatchObject({code:'computer_profile_missing'})
 await expect(read('resolve-workspace','../escape')).rejects.toMatchObject({code:'computer_profile_invalid'})
 await writeFile(join(home,'config.yaml'),'not valid config')
 await expect(read()).rejects.toMatchObject({code:'computer_profile_config_invalid'})
})
it('still requires a usable model for an Agent run and does not expose SDK details',async()=>{
 await writeFile(join(home,'config.yaml'),'{}')
 await expect(read('resolve')).rejects.toMatchObject({code:'computer_model_missing'})
 await writeFile(join(home,'config.yaml'),JSON.stringify({model:{default:'fixture',provider:'fixture'}}))
 await expect(read('resolve')).rejects.toMatchObject({code:'computer_model_unavailable'})
 try{await read('resolve')}catch(error){expect(String(error)).not.toContain('provider secret')}
})

it('resolves only each selected Profile proxy snapshot, preserving case and explicit empty values',async()=>{
 const profiles={
  default:{HTTP_PROXY:'http://user:proxy-secret@127.0.0.1:7890',HTTPS_PROXY:'http://127.0.0.1:7891',ALL_PROXY:'socks5://127.0.0.1:7892',NO_PROXY:'localhost,127.0.0.1,::1'},
  writer:{http_proxy:'http://127.0.0.1:8890',https_proxy:'http://127.0.0.1:8891',all_proxy:'',no_proxy:'internal.test'},
  direct:{},
 }
 vi.stubEnv('HTTPS_PROXY','http://runner-secret@127.0.0.1:9999')
 // A provider import must not change the already captured Profile snapshot.
 await writeFile(join(source,'hermes_cli','runtime_provider.py'),'import os\nos.environ["HTTPS_PROXY"]="http://fallback-secret@127.0.0.1:9998"\ndef resolve_runtime_provider(**kwargs): return {"provider":"custom","api_mode":"chat_completions","api_key":"model-private-key"}\n')
 for(const [profile,proxyEnv] of Object.entries(profiles)){
  const directory=profile==='default'?home:join(home,'profiles',profile)
  await mkdir(directory,{recursive:true})
  await writeFile(join(directory,'config.yaml'),JSON.stringify({model:{default:'fixture',provider:'custom'}}))
  await writeFile(join(directory,'.env'),JSON.stringify({...proxyEnv,UNRELATED_SECRET:'profile-private-key',BARE_KEY:null}))
 }
 const frames=await Promise.all(Object.keys(profiles).map(profile=>read('resolve',profile)))
 frames.forEach((frame,index)=>{
  expect(frame.proxyEnv??{}).toEqual(Object.values(profiles)[index])
  expect(frame.model).toEqual({provider:'custom',api_mode:'chat_completions',api_key:'model-private-key',model:'fixture'})
  expect(JSON.stringify(frame)).not.toMatch(/profile-private-key|runner-secret|fallback-secret/)
 })
 expect(frames[2]).not.toHaveProperty('proxyEnv')
 expect(await read('resolve-workspace')).not.toHaveProperty('proxyEnv')
 await rm(join(home,'.env'))
 expect(await read('resolve')).not.toHaveProperty('proxyEnv')
})

it('starts Python with only explicit proxy keys and never inherits Runner secrets or proxy variables',async()=>{
 const proxyEnv={HTTP_PROXY:'http://user:proxy-secret@127.0.0.1:7890',HTTPS_PROXY:'',ALL_PROXY:'socks5://127.0.0.1:7891',NO_PROXY:'localhost,127.0.0.1',http_proxy:'',https_proxy:'http://127.0.0.1:7892',all_proxy:'',no_proxy:'internal.test'}
 for(const key of Object.keys(proxyEnv))vi.stubEnv(key,'runner-private-proxy')
 vi.stubEnv('WORKER_SECRET','runner-private-key')
 const script=join(root,'environment.py')
 await writeFile(script,'import os,sys,json\nboot=json.loads(sys.stdin.readline())\nprint(json.dumps({"nonce":boot["nonce"],"type":"resolved","env":dict(os.environ),"boot":boot}),flush=True)\n')
 for(const configured of [proxyEnv,undefined]){
  const worker=new HermesWorkerProcess('python3',script,{proxyEnv:configured?{...configured,WORKER_SECRET:'injected-private-key',PYTHONPATH:'/forbidden',HOME:'/forbidden',PATH:'/forbidden'}:undefined})
  workers.push(worker)
  const frame=await worker.wait('resolved')
  for(const key of Object.keys(proxyEnv))expect(frame.env[key]).toBe(configured?.[key as keyof typeof proxyEnv])
  expect(frame.env).toMatchObject({HOME:homedir(),PATH:process.env.PATH,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'})
  expect(frame.env).not.toHaveProperty('WORKER_SECRET')
  expect(frame.env).not.toHaveProperty('PYTHONPATH')
  expect(frame.boot).not.toHaveProperty('proxyEnv')
 }
})
