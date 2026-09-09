// @vitest-environment node
import {afterEach,beforeEach,expect,it} from 'vitest'
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
 await writeFile(join(source,'dotenv.py'),'def dotenv_values(path): return {}\n')
 await writeFile(join(source,'hermes_constants.py'),'def set_hermes_home_override(path): pass\n')
 await writeFile(join(source,'hermes_cli','config.py'),'import os,json\nfrom pathlib import Path\ndef load_config_readonly(): return json.loads((Path(os.environ["HERMES_HOME"])/"config.yaml").read_text())\n')
 await writeFile(join(source,'hermes_cli','runtime_provider.py'),'raise RuntimeError("provider secret must never escape")\n')
})
afterEach(async()=>{await Promise.all(workers.splice(0).map(w=>w.close()));await rm(root,{recursive:true,force:true})})
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
