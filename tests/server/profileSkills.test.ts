// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,rename} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {ProfileSkillSession} from '../../src/runner/worker/skills'
import {HermesWorkerProcess} from '../../src/runner/worker/process'

const exec=promisify(execFile)
let root:string,home:string,source:string,allowed:boolean
const script=resolve('src/runner/worker/hermes_worker.py')
const spec=(name:string,body='Use the tested script.')=>'---\n'+JSON.stringify({name,description:'Reusable fixture procedure'})+'\n---\n'+body
beforeEach(async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-skills-')));home=join(root,'profile');source=join(root,'source');allowed=true
  await mkdir(join(source,'hermes_cli'),{recursive:true});await mkdir(home)
  await writeFile(join(home,'config.yaml'),'{}')
  await writeFile(join(source,'dotenv.py'),'def dotenv_values(path): return {}\n')
  await writeFile(join(source,'hermes_constants.py'),'def set_hermes_home_override(path): pass\n')
  await writeFile(join(source,'hermes_cli','config.py'),'import os,json\nfrom pathlib import Path\ndef load_config_readonly(): return json.loads((Path(os.environ["HERMES_HOME"])/"config.yaml").read_text())\n')
  // JSON frontmatter is valid YAML. Native PyYAML interoperability is covered
  // separately by the real-Hermes live test; no system Python dependency here.
  await writeFile(join(source,'yaml.py'),'import json\ndef safe_load(text): return json.loads(text)\ndef safe_dump(value, **kwargs): return json.dumps(value,ensure_ascii=False)+"\\n"\n')
})
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})
async function skill(directory:string,name='fixture-skill',body?:string){
  await mkdir(join(directory,'scripts'),{recursive:true})
  await writeFile(join(directory,'SKILL.md'),spec(name,body))
  await writeFile(join(directory,'scripts','proof.py'),'print("verified procedure")\n')
}
function session(profile='default'){
  const installs:any[]=[]
  const authorize=async()=>{if(!allowed)throw new Error('revoked')}
  const service=new ProfileSkillSession({python:'python3',script,hermesSource:source,hermesHome:home,profile,ownerKey:'owner',agentId:'bot-1',taskId:'task-1',signal:new AbortController().signal,authorize,
    execute:async(argv)=>{await authorize();return exec(argv[0]!,argv.slice(1),{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:10*1024*1024})},
    install:async(bundle)=>{await authorize();installs.push(bundle);return {path:'/opt/yaoyao-skills/'+bundle.namespace+'/'+bundle.revision,revision:bundle.revision}},
  })
  return {service,installs,call:(name:string,args:unknown={})=>service.call('computer_'+name,args) as Promise<any>}
}
async function publish(f:ReturnType<typeof session>,directory:string,expected_revision:string|null=null){
  return f.call('skill_publish',{name:'fixture-skill',directory,expected_revision,validation_command:'python3 scripts/proof.py'})
}

it('discovers only selected Profile and configured external roots, respecting disabled names and preserving package resources',async()=>{
  const external=join(root,'external');await skill(join(external,'outside'),'outside-skill')
  await skill(join(home,'skills','category','fixture-skill'))
  await writeFile(join(home,'skills','category','fixture-skill','操作说明.md'),'可复用的操作步骤')
  await skill(join(home,'skills','disabled'),'disabled-skill')
  await writeFile(join(home,'config.yaml'),JSON.stringify({skills:{disabled:['disabled-skill'],external_dirs:[external]}}))
  const named=join(home,'profiles','writer');await mkdir(named,{recursive:true});await writeFile(join(named,'config.yaml'),'{}');await skill(join(named,'skills','writer'),'writer-skill')
  const f=session(),catalog=await f.call('skills_list')
  expect(catalog.skills.map((s:any)=>s.name)).toEqual(['fixture-skill','outside-skill'])
  expect((await session('writer').call('skills_list')).skills.map((s:any)=>s.name)).toEqual(['writer-skill'])
  const view=await f.call('skill_view',{name:'fixture-skill'})
  expect(view).toMatchObject({readOnly:true,execution:'linux-vm',files:expect.arrayContaining(['SKILL.md','scripts/proof.py','操作说明.md'])})
  expect(JSON.stringify(view)).not.toContain(home)
  expect((await f.call('skill_view',{name:'fixture-skill',file_path:'scripts/proof.py'})).content).toContain('verified procedure')
  expect((await f.call('skill_view',{name:'disabled-skill'})).code).toBe('skill_missing')
})

it('publishes a validated package into the native Profile, freezes current-turn reads and records versioned rollback',async()=>{
  const draft=join(root,'draft');await skill(draft)
  const f=session(),first=await publish(f,draft)
  expect(first).toMatchObject({published:true,profileAvailable:true,previous:null})
  const formal=join(home,'skills','bot-learned','fixture-skill')
  const text=await readFile(join(formal,'SKILL.md'),'utf8')
  expect(text).toContain('computer_shell');expect(text).not.toContain('"platforms"')
  expect(await readFile(join(formal,'scripts','proof.py'),'utf8')).toContain('verified procedure')
  const frozen=await f.call('skill_view',{name:'fixture-skill'})
  await writeFile(join(draft,'scripts','proof.py'),'print("second procedure")\n')
  const second=await publish(f,draft,first.revision)
  expect(second.revision).not.toBe(first.revision)
  expect((await f.call('skill_view',{name:'fixture-skill'})).revision).toBe(frozen.revision)
  expect((await session().call('skill_view',{name:'fixture-skill'})).revision).toBe(second.revision)
  expect((await publish(f,draft,first.revision)).code).toBe('skill_revision_conflict')
  const history=await f.call('skill_history',{name:'fixture-skill'})
  expect(history.history).toHaveLength(2)
  expect(history.history[1]).toMatchObject({agentId:'bot-1',taskId:'task-1',previous:first.revision,validation:expect.stringContaining('exit: 0')})
  const restored=await f.call('skill_restore',{name:'fixture-skill',revision:first.revision,expected_revision:second.revision,reason:'Restore previously validated procedure'})
  expect(restored.revision).toBe(first.revision)
  expect(await readFile(join(formal,'scripts','proof.py'),'utf8')).toContain('verified procedure')
})

it('serializes concurrent publishers and refuses to overwrite user-owned or external skills',async()=>{
  const draft=join(root,'draft');await skill(draft)
  const results=await Promise.all([publish(session(),draft),publish(session(),draft)])
  expect(results.filter(result=>result.published)).toHaveLength(1)
  expect(results.filter(result=>result.code==='skill_revision_conflict')).toHaveLength(1)
  await skill(join(home,'skills','user-skill'),'user-skill')
  await skill(draft,'user-skill')
  expect(await session().call('skill_publish',{name:'user-skill',directory:draft,expected_revision:null,validation_command:'true'})).toMatchObject({code:'skill_not_managed'})
})

it('refuses failed validation, changing drafts, traversal, links, foreign Profile fields and revoked calls',async()=>{
  const draft=join(root,'draft');await skill(draft);const f=session()
  expect(await f.call('skill_publish',{name:'fixture-skill',directory:draft,expected_revision:null,validation_command:'exit 1'})).toMatchObject({code:'skill_validation_failed'})
  expect(await f.call('skill_publish',{name:'fixture-skill',directory:draft,expected_revision:null,validation_command:'printf changed > scripts/proof.py'})).toMatchObject({code:'skill_draft_changed'})
  await expect(f.call('skill_view',{name:'../escape'})).rejects.toThrow()
  await expect(f.call('skill_view',{name:'fixture-skill',profile:'writer'})).rejects.toThrow()
  await expect(f.call('skill_view',{name:'fixture-skill',file_path:'../secret'})).rejects.toThrow()
  await symlink(join(home,'config.yaml'),join(draft,'linked.yaml'))
  expect((await publish(f,draft)).code).toBe('skill_draft_invalid')
  allowed=false;await expect(f.call('skills_list')).rejects.toThrow('revoked')
  expect((await readFile(join(home,'config.yaml'),'utf8'))).toBe('{}')
})

it('respects Profile write approval and does not adopt untracked Bot-category directories',async()=>{
  const draft=join(root,'draft');await skill(draft)
  await writeFile(join(home,'config.yaml'),JSON.stringify({skills:{write_approval:'true'}}))
  expect((await publish(session(),draft)).code).toBe('skill_write_disabled')
  await writeFile(join(home,'config.yaml'),'{}')
  await skill(join(home,'skills','bot-learned','fixture-skill'))
  expect((await publish(session(),draft)).code).toBe('skill_not_managed')
})

it('runs configured scanning before publication and preserves a native edit racing the commit',async()=>{
  const draft=join(root,'draft');await skill(draft)
  await mkdir(join(source,'tools'));await writeFile(join(source,'tools','skills_guard.py'),'def scan_skill(*args, **kwargs): return {}\ndef should_allow_install(result): return False,"blocked"\n')
  await writeFile(join(home,'config.yaml'),JSON.stringify({skills:{guard_agent_created:true}}))
  expect((await publish(session(),draft)).code).toBe('skill_scan_blocked')
  await expect(readFile(join(home,'skills','bot-learned','fixture-skill','SKILL.md'))).rejects.toMatchObject({code:'ENOENT'})
  await writeFile(join(home,'config.yaml'),'{}')
  const first=await publish(session(),draft),formal=join(home,'skills','bot-learned','fixture-skill','SKILL.md')
  const worker=new HermesWorkerProcess('python3',script,{mode:'skills',profile:'default',hermesSource:source,hermesHome:home,action:'publish',arguments:{name:'fixture-skill',files:{'SKILL.md':Buffer.from(spec('fixture-skill','new version')).toString('base64')},expectedRevision:first.revision,validation:'passed'},provenance:{ownerKey:'owner'}})
  worker.onTool=async()=>{await writeFile(formal,spec('fixture-skill','native edit wins'));return {authorized:true}}
  try{expect((await worker.wait('skills')).result.code).toBe('skill_revision_conflict')}finally{await worker.close()}
  expect(await readFile(formal,'utf8')).toContain('native edit wins')
})

it('rechecks authority at host commit and recovers an interrupted directory replacement',async()=>{
  const draft=join(root,'draft');await skill(draft)
  const f=session(),first=await publish(f,draft),formal=join(home,'skills','bot-learned','fixture-skill')
  await rename(formal,join(home,'.yaoyao-skills','fixture-skill.previous'))
  // Discovery also repairs an interrupted commit; it does not hide the skill.
  expect((await session().call('skills_list')).skills.map((s:any)=>s.name)).toContain('fixture-skill')
  await writeFile(join(draft,'scripts','proof.py'),'print("after recovery")\n')
  const next=await publish(f,draft,first.revision)
  expect(next).toMatchObject({published:true,previous:first.revision})
  const files={'SKILL.md':Buffer.from(spec('blocked-skill')).toString('base64')}
  const worker=new HermesWorkerProcess('python3',script,{mode:'skills',profile:'default',hermesSource:source,hermesHome:home,action:'publish',arguments:{name:'blocked-skill',files,expectedRevision:null,validation:'passed'},provenance:{ownerKey:'owner'}})
  worker.onTool=async()=>{throw new Error('revoked just before commit')}
  try{expect((await worker.wait('skills')).result.code).toBe('skill_cancelled')}finally{await worker.close()}
  await expect(readFile(join(home,'skills','bot-learned','blocked-skill','SKILL.md'))).rejects.toMatchObject({code:'ENOENT'})
})
