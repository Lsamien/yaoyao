// @vitest-environment node
import {expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {ContainerComputerProvider} from '../../src/runner/computers/container'
import {ComposeComputerProvider} from '../../src/runner/computers/compose'
import {ProfileSkillSession} from '../../src/runner/worker/skills'
const exec=promisify(execFile)
const docker=(args:string[])=>exec('docker',args,{timeout:90000,maxBuffer:12*1024*1024})
const enabled=['YAOYAO_COMPUTER_IMAGE','YAOYAO_HERMES_PYTHON','YAOYAO_HERMES_SOURCE'].every(key=>!!process.env[key])

it.skipIf(!enabled).each(['local','compose'])('shares real native Profile skills with a %s desktop and publishes validated, immutable revisions',async mode=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-skill-live-'))),home=join(root,'hermes'),id=randomUUID(),runner=randomUUID()
  const fixture='yaoyao-skill-test-'+id.slice(0,8),ipc=fixture+'-ipc',workspace=fixture+'-workspace'
  const image=process.env.YAOYAO_COMPUTER_IMAGE!,python=process.env.YAOYAO_HERMES_PYTHON!,source=process.env.YAOYAO_HERMES_SOURCE!
  const spec={id,ownerKey:'fixture',imageId:image,cwd:'/home/cua/workspace'},context={authorize:()=>{}}
  let provider:ContainerComputerProvider=new ContainerComputerProvider('docker',runner,root)
  await mkdir(join(home,'skills','source-proof','scripts'),{recursive:true});await writeFile(join(home,'config.yaml'),'{}')
  await writeFile(join(home,'skills','source-proof','SKILL.md'),'---\nname: source-proof\ndescription: A source skill for isolated verification\n---\nRun scripts/proof.py in the assigned Linux computer.\n')
  await writeFile(join(home,'skills','source-proof','scripts','proof.py'),'print("source-skill-proof")\n')
  try{
    if(mode==='compose'){
      await docker(['run','-d','--name',fixture,'--network','none','--shm-size','512m','--memory','2g','--cap-drop','ALL','--cap-add','SETUID','--cap-add','SETGID','--cap-add','CHOWN','--cap-add','KILL','--security-opt','no-new-privileges:true',
        '--env','YAOYAO_COMPOSE_DESKTOP_ID='+id,'--mount',`type=bind,src=${resolve('deploy/computer')},dst=/usr/local/libexec/yaoyao,readonly`,
        '--mount',`type=volume,src=${ipc},dst=/run/yaoyao-private/bridge`,'--mount',`type=volume,src=${ipc},dst=/run/skill-test`,
        '--mount',`type=volume,src=${workspace},dst=/home/cua/workspace`,image])
      const relay=async(_id:string,op:string,body:Record<string,unknown>)=>{
        if(op==='list')return [{id,name:'fixture',ready:true}]
        const code="import http.client,socket,sys; c=http.client.HTTPConnection('localhost'); c.sock=socket.socket(socket.AF_UNIX); c.sock.connect('/run/skill-test/desktop.sock'); c.request('POST',sys.argv[1],sys.argv[2].encode('utf-8')); r=c.getresponse(); print(r.read().decode()); sys.exit(0 if r.status==200 else 1)"
        return JSON.parse((await docker(['exec','--user','1000:1000',fixture,'python3','-c',code,'/'+op,JSON.stringify({...body,owner:'fixture',desktopId:id})])).stdout)
      }
      provider=new ComposeComputerProvider(runner,root,relay)
      await vi.waitFor(async()=>expect((await relay(id,'health',{})).ready).toBe(true),{timeout:65000,interval:1000})
    }
    await provider.ensure(spec,()=>{})
    const makeSession=()=>new ProfileSkillSession({python,script:resolve('src/runner/worker/hermes_worker.py'),hermesSource:source,hermesHome:home,profile:'default',ownerKey:'fixture',agentId:id,taskId:randomUUID(),signal:new AbortController().signal,
      authorize:async()=>{},execute:(argv,input)=>provider.execute(spec,argv,{...context,input}),install:(bundle,script)=>provider.installSkill(spec,bundle,script,context)})
    const session=makeSession()
    expect((await session.call('computer_skills_list',{}) as any).skills.map((s:any)=>s.name)).toContain('source-proof')
    const view=await session.call('computer_skill_view',{name:'source-proof'}) as any
    expect((await provider.execute(spec,['python3',view.path+'/scripts/proof.py'],context)).stdout.trim()).toBe('source-skill-proof')
    await expect(provider.execute(spec,['chmod','u+w',view.path+'/SKILL.md'],context)).rejects.toThrow()
    await expect(provider.execute(spec,['sh','-c','echo changed > "$1/SKILL.md"','sh',view.path],context)).rejects.toThrow()
    const draft='/home/cua/workspace/learned'
    await provider.execute(spec,['python3','-c','import pathlib,sys; p=pathlib.Path(sys.argv[1]); (p/"scripts").mkdir(parents=True); (p/"SKILL.md").write_text("---\\nname: learned-proof\\ndescription: Tested reusable Linux procedure\\n---\\nRun scripts/proof.py.\\n"); (p/"scripts/proof.py").write_text("print(42)\\n")',draft],context)
    const published=await session.call('computer_skill_publish',{name:'learned-proof',directory:draft,expected_revision:null,validation_command:'python3 scripts/proof.py'}) as any
    expect(published).toMatchObject({published:true,profileAvailable:true})
    // Query the real Hermes discovery and view functions, using a temporary
    // Profile with no credentials. This proves native interoperability.
    const native="import sys,json; sys.path.insert(0,sys.argv[1]); from tools.skills_tool import skills_list,skill_view; print(json.dumps({'list':skills_list(),'view':skill_view('learned-proof')}))"
    const output=(await exec(python,['-c',native,source],{env:{PATH:process.env.PATH,HOME:root,HERMES_HOME:home,PYTHONDONTWRITEBYTECODE:'1'},maxBuffer:8*1024*1024})).stdout
    expect(output).toContain('learned-proof');expect(output).toContain('computer_shell')
    expect(output).not.toContain('not found')
    const fromOtherBot=await makeSession().call('computer_skill_view',{name:'learned-proof'}) as any
    expect(fromOtherBot.revision).toBe(published.revision)
    expect((await provider.execute(spec,['python3',fromOtherBot.path+'/scripts/proof.py'],context)).stdout.trim()).toBe('42')
    expect(await readFile(join(home,'skills','source-proof','scripts','proof.py'),'utf8')).toContain('source-skill-proof')
  }finally{
    if(mode==='local')await provider.remove(spec)
    else{await docker(['rm','-f',fixture]).catch(()=>{});await docker(['volume','rm',ipc,workspace]).catch(()=>{})}
    await rm(root,{recursive:true,force:true})
  }
},150000)
