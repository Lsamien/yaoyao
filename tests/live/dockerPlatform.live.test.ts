// @vitest-environment node
import {it,expect} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import request from 'supertest'
import {chromium} from '@playwright/test'
import {UNCONFIGURED_COMPUTER_IMAGE} from '../../src/shared/runner'
const exec=promisify(execFile)
it.skipIf(!process.env.YAOYAO_PLATFORM_IMAGE||!process.env.YAOYAO_COMPUTER_IMAGE||!process.env.YAOYAO_HERMES_PYTHON)('executes an isolated task through the packaged Docker control plane and an external Runner',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-docker-platform-')),name=`yaoyao-platform-${randomUUID()}`,webHome=join(home,'web'),hermesHome=join(home,'hermes')
  await mkdir(webHome);await mkdir(hermesHome)
  const fixed=!!process.env.YAOYAO_COMPOSE_DESKTOP_IMAGE
  let webContainer=name,composeIds:string[]=[],desktopId=''
  const override=join(home,'compose.override.json')
  const compose=(args:string[])=>exec('docker',['compose','--project-name',name,'--project-directory',resolve('.'),'--env-file',resolve('docker.env.example'),'-f',resolve('compose.desktops.yaml'),'-f',override,...args],{env:{...process.env,HERMES_YAOYAO_PUBLISHED_PORT:'0',HERMES_YAOYAO_BIND_ADDRESS:'127.0.0.1',HERMES_YAOYAO_UPSTREAM:`http://host.docker.internal:${upstreamPort}`}})
  const upstream=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json')
    if(req.method==='GET'){res.end(JSON.stringify(req.url?.startsWith('/api/profiles')?{profiles:[{name:'default'}]}:req.url?.startsWith('/api/config')?{terminal:{cwd:'/workspace/docker-proof'}}:{ok:true}));return}
    let body='';for await(const chunk of req)body+=chunk
    const input=JSON.parse(body||'{}'),called=input.messages?.some((message:any)=>message.role==='tool'),exported=input.messages?.some((message:any)=>message.role==='tool'&&message.name==='computer_export')
    const message=exported?{role:'assistant',content:'Docker 控制面任务完成'}:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:called?'computer_export':'computer_shell',arguments:JSON.stringify(called?{path:'docker-proof.txt'}:{command:'printf docker-control-plane-proof > docker-proof.txt; id -u'})}}]}
    if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:randomUUID(),object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((tool,index)=>({...tool,index}))}:{})},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')}
    else res.end(JSON.stringify({id:randomUUID(),object:'chat.completion',model:'fixture-model',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}))
  })
  await new Promise<void>(done=>upstream.listen(0,'0.0.0.0',done));const upstreamPort=(upstream.address() as {port:number}).port
  let child:ReturnType<typeof spawn>|undefined,exited:Promise<void>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  try{
    if(fixed){
      await writeFile(override,JSON.stringify({services:{web:{image:process.env.YAOYAO_PLATFORM_IMAGE},'desktop-1':{image:process.env.YAOYAO_COMPOSE_DESKTOP_IMAGE},'desktop-2':{image:process.env.YAOYAO_COMPOSE_DESKTOP_IMAGE}}}))
      await compose(['up','-d','--no-build'])
      webContainer=(await compose(['ps','-q','web'])).stdout.trim()
      composeIds=(await compose(['ps','-q','desktop-1','desktop-2'])).stdout.trim().split(/\s+/)
      expect(composeIds).toHaveLength(2)
    }else await exec('docker',['run','-d','--name',name,'--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:mode=1777','--add-host','host.docker.internal:host-gateway','-p','127.0.0.1::15300','--mount',`type=volume,source=${name}-data,target=/var/lib/hermes-yaoyao`,'-e','HERMES_YAOYAO_ALLOW_INSECURE_LAN=1','-e','HERMES_YAOYAO_ALLOWED_HOSTS=localhost,127.0.0.1','-e',`HERMES_YAOYAO_UPSTREAM=http://host.docker.internal:${upstreamPort}`,process.env.YAOYAO_PLATFORM_IMAGE!])
    const detail=JSON.parse((await exec('docker',['inspect',webContainer])).stdout)[0],port=detail.NetworkSettings.Ports['15300/tcp'][0].HostPort,address=`http://127.0.0.1:${port}`,client=request.agent(address)
    await expect.poll(async()=>{try{return (await client.get('/healthz')).status}catch{return 0}},{timeout:30000}).toBe(200)
    expect(detail.Config.User).toBe('node');expect(detail.HostConfig.ReadonlyRootfs).toBe(true);expect(detail.HostConfig.CapDrop).toContain('ALL')
    expect((await exec('docker',['exec',webContainer,'id','-u'])).stdout.trim()).toBe('1000')
    expect(detail.Mounts.every((mount:any)=>!mount.Destination.includes('docker.sock')&&!mount.Destination.includes('.hermes'))).toBe(true)
    if(fixed){
      for(const id of composeIds){
        const desktop=JSON.parse((await exec('docker',['inspect',id])).stdout)[0]
        expect(Object.values(desktop.NetworkSettings.Ports??{}).every(value=>value===null)).toBe(true)

      }
    }
    await client.get('/api/app/admin/runners/bundle').expect(401)
    const bootstrap=await client.get('/api/app/bootstrap').expect(200)
    const setup=await client.post('/api/app/setup').set('Origin',address).set('X-CSRF-Token',bootstrap.body.csrfToken).send({username:'docker-fixture',password:'docker-fixture-password'}).expect(200)
    expect(setup.body.user.id).toBeTruthy()
    const fresh=await client.get('/api/app/bootstrap').expect(200)
    const post=(path:string,body:unknown)=>client.post(path).set('Origin',address).set('X-CSRF-Token',fresh.body.csrfToken).send(body)
    const localVm='/api/app/admin/local-vm'
    expect((await client.get(localVm).expect(200)).body).toMatchObject({configured:false,executionHost:'runner',setupRequired:'runner'})
    await post(localVm+'/prepare',{requestId:randomUUID()}).expect(409)
    const bundle=await client.get('/api/app/admin/runners/bundle').buffer(true).parse((response,done)=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>done(null,Buffer.concat(chunks)))}).expect(200)
    const bundlePath=join(home,'yaoyao-runner.tar.gz'),runnerHome=join(home,'runner')
    await writeFile(bundlePath,bundle.body);await mkdir(runnerHome)
    await exec('tar',['-xzf',bundlePath,'-C',runnerHome])
    for(const file of ['runner.mjs','hermes_worker.py','guest_proxy.py','computer-image/Dockerfile','third-party/openmausbot/LICENSE'])expect((await readFile(join(runnerHome,file))).length).toBeGreaterThan(0)
    browser=await chromium.launch({headless:true})
    const page=await browser.newPage({viewport:{width:1440,height:960}})
    await page.goto(address+'/conversations')
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('docker-fixture')
    await page.getByRole('textbox',{name:'密码',exact:true}).fill('docker-fixture-password')
    await page.getByRole('button',{name:'登录',exact:true}).click()
    await page.getByRole('button',{name:'设置与模式',exact:true}).first().click()
    await page.getByRole('menuitem',{name:'进入设置',exact:true}).click()
    const settings=page.getByRole('dialog',{name:'设置中心'})
    await settings.getByRole('button',{name:'本地虚拟机',exact:true}).click()
    await settings.getByRole('button',{name:'打开执行节点设置',exact:true}).click()
    await expect.poll(()=>settings.getByRole('link',{name:'下载配套执行节点程序'}).count()).toBe(1)
    expect(await settings.getByRole('checkbox',{name:'启用隔离电脑 Worker',exact:true}).isChecked()).toBe(true)
    const registration=await post('/api/app/admin/runners',{name:'容器外执行节点',allowedProfiles:['default']}).expect(201)
    const runnerID=registration.body.runner.id
    await writeFile(join(hermesHome,'config.yaml'),`model:\n  provider: custom\n  default: fixture-model\n  base_url: http://127.0.0.1:${upstreamPort}/v1\n  api_key: fixture-key\n  api_mode: chat_completions\nterminal:\n  cwd: /workspace/docker-proof\n`,{mode:0o600})
    const config={protocol:1,serverURL:address,runnerId:runnerID,token:registration.body.token,hermesURL:`http://127.0.0.1:${upstreamPort}`,allowedProfiles:['default'],artifactRoots:[],computers:{...(fixed?{managedBy:'compose'}:{}),runtime:'docker',network:'none',imageId:UNCONFIGURED_COMPUTER_IMAGE,python:process.env.YAOYAO_HERMES_PYTHON,hermesSource:process.env.YAOYAO_HERMES_SOURCE,hermesHome}}
    const path=join(home,'runner.json');await writeFile(path,JSON.stringify(config),{mode:0o600})
    child=spawn(process.execPath,[join(runnerHome,'runner.mjs'),'--config',path],{stdio:'ignore'})
    exited=new Promise(done=>child!.once('exit',()=>done()))
    await expect.poll(async()=>(await client.get('/api/app/admin/runners')).body.runners?.some((runner:any)=>runner.id===runnerID&&runner.online),{timeout:15000}).toBe(true)
    await settings.getByRole('button',{name:'收起执行节点设置',exact:true}).click()
    await settings.getByRole('button',{name:'重新检查',exact:true}).click()
    if(fixed){
      expect(await settings.getByRole('combobox',{name:'虚拟机数量上限'}).count()).toBe(0)
      expect(await settings.getByRole('button',{name:'准备本地虚拟机',exact:true}).count()).toBe(0)
      const inventory=(await client.get(localVm)).body;expect(inventory.fixedCapacity).toBe(true);expect(inventory.maxInstances).toBe(2);desktopId=inventory.desktops[0].id
    }else await settings.getByRole('button',{name:'准备本地虚拟机',exact:true}).click()
    await expect.poll(async()=>(await client.get(localVm)).body.image,{timeout:90000}).toBe(true)
    if(fixed){
      await expect.poll(async()=>(await client.get(localVm)).body.desktops.every((d:any)=>d.ready),{timeout:90000}).toBe(true)
      for(const id of composeIds){
        const denied=await exec('docker',['exec','--user','1000:1000',id,'python3','-c',"import socket; s=socket.socket(socket.AF_UNIX);\ntry:s.connect('/run/yaoyao-private/bridge/desktop.sock');print('accessible')\nexcept PermissionError:print('blocked')"])
        expect(denied.stdout.trim()).toBe('blocked')
      }
    }
    const created=await post('/api/app/agents',{name:'Docker 隔离成员',profile:'default',execution:'computer'}).expect(201)
    const agentID=created.body.agent.id,conversations=await client.get('/api/app/conversations').expect(200),conversation=conversations.body.conversations.find((item:any)=>item.memberIds.includes(agentID))
    if(fixed)await client.put(`/api/app/agents/${agentID}/local-vm`).set('Origin',address).set('X-CSRF-Token',fresh.body.csrfToken).send({enabled:true,desktopId}).expect(200)
    const sent=await post(`/api/app/conversations/${conversation.id}/messages`,{requestId:randomUUID(),content:'执行当前隔离工具并导出结果。'}).expect(202)
    let result:any,message:any
    await expect.poll(async()=>{result=(await client.get(`/api/app/conversations/${conversation.id}`)).body;message=result.messages?.find((item:any)=>item.role==='assistant'&&item.runId===sent.body.run.id);return message?.status??'pending'},{timeout:45000}).toMatch(/complete|failed|uncertain/)
    expect(message.status,JSON.stringify(result)).toBe('complete')
    expect(message.runId).toBe(sent.body.run.id)
    const file=message.attachments?.[0]
    expect(file?.id).toBeTruthy()
    expect((await client.get(`/api/app/files/${file.id}/download`).expect(200)).text).toBe('docker-control-plane-proof')
    if(fixed)expect((await exec('docker',['exec','--user','1000:1000',composeIds[0]!,'cat','/home/cua/workspace/docker-proof.txt'])).stdout).toBe('docker-control-plane-proof')
    else expect(await readFile(join(home,'state',runnerID,'computer-workspaces',agentID,'docker-proof.txt'),'utf8')).toBe('docker-control-plane-proof')
    const computerBase=`/api/app/agents/${agentID}/computer`
    // Shell tasks can finish before the desktop capture service is ready.
    await expect.poll(async()=>(await client.get(`/api/app/agents/${agentID}/local-vm`)).body.ready,{timeout:30000}).toBe(true)
    const frame=(await client.get(computerBase+'/frame').expect(200)).body
    expect(frame.width).toBeGreaterThan(1000);expect(frame.data.length).toBeGreaterThan(1000)
    const taken=await post(computerBase+'/take',{requestId:randomUUID()}).expect(200)
    await expect.poll(async()=>(await client.get(computerBase)).body.mode,{timeout:15000}).toBe('human')
    await post(computerBase+'/giveback',{controlId:taken.body.controlId,token:taken.body.token}).expect(200)
    const changeMode=(mode:string)=>client.put(localVm+'/policy').set('Origin',address).set('X-CSRF-Token',fresh.body.csrfToken).send({requestId:randomUUID(),mode,maxInstances:2})
    await changeMode('shared').expect(fixed?409:200);await changeMode('per-bot').expect(fixed?409:200)
    if(fixed){
      for(const action of ['create','recreate','remove','start','stop'])await post(`/api/app/agents/${agentID}/local-vm/${action}`,{}).expect(409)
      const second=(await post('/api/app/agents',{name:'共用桌面的第二个成员',profile:'default'}).expect(201)).body.agent
      await client.put(`/api/app/agents/${second.id}/local-vm`).set('Origin',address).set('X-CSRF-Token',fresh.body.csrfToken).send({enabled:true,desktopId}).expect(200)
      expect((await client.get(`/api/app/agents/${second.id}/local-vm`)).body.desktopId).toBe(desktopId)
      const secondChat=(await client.get('/api/app/conversations')).body.conversations.find((c:any)=>c.memberIds.includes(second.id))
      const task=await post(`/api/app/conversations/${secondChat.id}/messages`,{requestId:randomUUID(),content:'在同一共享桌面执行并导出结果。'}).expect(202)
      await expect.poll(async()=>(await client.get(`/api/app/conversations/${secondChat.id}`)).body.messages.find((m:any)=>m.role==='assistant'&&m.runId===task.body.run.id)?.status,{timeout:45000}).toBe('complete')
      expect((await compose(['ps','-q','desktop-1','desktop-2'])).stdout.trim().split(/\s+/).sort()).toEqual([...composeIds].sort())
    }
    await settings.getByRole('button',{name:'关闭设置中心'}).click()
    await page.goto(address+`/conversations/${conversation.id}`)
    await page.getByRole('button',{name:'电脑',exact:true}).click()
    await expect.poll(()=>page.getByRole('complementary',{name:'Agent 电脑面板'}).getByRole('img').count(),{timeout:20000}).toBe(1)
    if(fixed){
      const dock=page.getByRole('complementary',{name:'Agent 电脑面板'})
      expect(await dock.getByRole('button',{name:'停止虚拟机',exact:true}).count()).toBe(0)
      const otherDesktop=(await client.get(localVm)).body.desktops[1].id
      page.once('dialog',dialog=>{void dialog.accept()})
      await dock.getByRole('combobox',{name:'此 Agent 使用的电脑'}).selectOption(otherDesktop)
      await expect.poll(async()=>(await client.get(`/api/app/agents/${agentID}/local-vm`)).body.desktopId).toBe(otherDesktop)
      await expect.poll(()=>dock.getByRole('img').count(),{timeout:15000}).toBe(1)
      expect((await compose(['ps','-q','desktop-1','desktop-2'])).stdout.trim().split(/\s+/).sort()).toEqual([...composeIds].sort())
    }
    const evidence=resolve(process.env.YAOYAO_DOCKER_EVIDENCE??'test-results/docker-platform')
    await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'docker-agent-desktop.png')})
    const identity=await client.get('/api/status').expect(200);expect(identity.body.server_kind).toBe('yaoyao-web')
  }catch(error){if(fixed){for(const id of composeIds){const log=await exec('docker',['exec',id,'sh','-c','tail -n 25 /var/log/supervisor/yaoyao-compose.error.log; ls -ld /run/yaoyao-private /run/yaoyao-private/bridge /run/yaoyao-private/bridge/desktop.sock']).catch(()=>({stdout:'desktop unavailable',stderr:''}));console.error(log.stdout,log.stderr)}}const logs=await exec('docker',['logs','--tail','35',webContainer]).catch(()=>({stdout:'',stderr:''}));console.error(logs.stdout,logs.stderr);throw error}finally{
    child?.kill('SIGTERM');await exited
    await browser?.close()
    if(fixed)await compose(['down','--volumes','--remove-orphans']).catch(()=>{})
    else{await exec('docker',['rm','-f',name]).catch(()=>{});await exec('docker',['volume','rm',name+'-data']).catch(()=>{})}
    await new Promise<void>(done=>{upstream.close(()=>done());upstream.closeAllConnections()})
    await rm(home,{recursive:true,force:true})
  }
},200000)
