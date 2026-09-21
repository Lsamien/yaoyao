// @vitest-environment node
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {GrokCloud} from '../../src/server/grokCloud'
import {agentEnvs,deriveComputer} from '../../src/shared/workspace'

let home:string,store:WorkspaceStore,nodes:WorkspaceNodes
const auth={require:(ctx:any)=>({id:ctx.get('x-user')||'owner',role:'admin'}),requireAdmin:(ctx:any)=>({id:ctx.get('x-user')||'owner',role:'admin'}),isUserActive:()=>true,pushAuthorizationVersion:()=>1} as any
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'agent-envs-'));store=new WorkspaceStore(home);nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any)})
afterEach(()=>{nodes.close();store.close();rmSync(home,{recursive:true,force:true})})
const app=(cloud:GrokCloud)=>{const a=new Koa();a.use(async(ctx,next)=>{try{await next()}catch(e:any){ctx.status=e.status??500;ctx.body={error:e.message,code:e.code}}});a.use(bodyParser());a.use(cloud.router().routes());return a.callback()}

it('derives parallel environments from legacy single choices and auto',()=>{
  expect(agentEnvs({computer:'vm'})).toEqual({vm:true,cloud:false,desktop:false,browser:false})
  expect(agentEnvs({computer:'cloud'})).toEqual({vm:false,cloud:true,desktop:false,browser:false})
  expect(agentEnvs({computer:'local'})).toEqual({vm:false,cloud:false,desktop:true,browser:false})
  expect(agentEnvs({computer:'auto'})).toEqual({vm:true,cloud:true,desktop:true,browser:false})
  expect(agentEnvs({computer:'off'})).toEqual({vm:false,cloud:false,desktop:false,browser:false})
  expect(agentEnvs({envs:{cloud:true,desktop:true}})).toEqual({vm:false,cloud:true,desktop:true,browser:false})
  expect(deriveComputer({vm:true,cloud:true,desktop:true,browser:false})).toBe('vm')
  expect(deriveComputer({cloud:true,desktop:true})).toBe('cloud')
  expect(deriveComputer({desktop:true})).toBe('local')
  expect(deriveComputer({})).toBe('off')
})

it('writes envs through computer-selection and projects computer for older clients while the chat stays on the server',async()=>{
  const cloud=new GrokCloud(store,auth,nodes,{assertLocalVmIdle:()=>{}} as any,vi.fn(async()=>new Response('{}')))
  const agent=store.createAgent('owner',{name:'并行机器人',profile:'default',computer:'auto'})
  const path=`/api/app/agents/${agent.id}/computer-selection`
  const first=await request(app(cloud)).put(path).send({envs:{vm:true,cloud:true,desktop:true}}).expect(200)
  expect(first.body.agent).toMatchObject({envs:{vm:true,cloud:true,desktop:true},computer:'vm',execution:'profile'})
  const cleared=await request(app(cloud)).put(path).send({envs:{}}).expect(200)
  expect(cleared.body.agent).toMatchObject({envs:{vm:true,cloud:true,desktop:true,browser:false},computer:'off',execution:'profile'})
  const desktopOnly=await request(app(cloud)).put(path).send({envs:{desktop:true}}).expect(200)
  expect(desktopOnly.body.agent).toMatchObject({envs:{vm:true,cloud:true,desktop:true,browser:false},computer:'local',execution:'profile',allowHostEnvironment:false})
  await request(app(cloud)).put(path).send({envs:{vm:true},desktopHost:'local'}).expect(200)
  expect(store.require<any>('owner','agent',agent.id)).toMatchObject({envs:{vm:true},desktopHost:'local',computer:'vm',execution:'profile'})
})

it('raw computer writes on an envs agent only toggle the VM leg',async()=>{
  const agent=store.createAgent('owner',{name:'混合',profile:'default',computer:'local'})
  store.updateAgent('owner',agent.id,{envs:{vm:true,cloud:true,desktop:true}})
  store.updateAgent('owner',agent.id,{computer:'off'})
  expect(store.require<any>('owner','agent',agent.id)).toMatchObject({envs:{vm:false,cloud:true,desktop:true},computer:'cloud',execution:'profile'})
  store.updateAgent('owner',agent.id,{computer:'vm'})
  expect(store.require<any>('owner','agent',agent.id)).toMatchObject({envs:{vm:true,cloud:true,desktop:true},computer:'vm',execution:'profile'})
})
it('selects the cloud environment in parallel regardless of desktop readiness',async()=>{
  const cloud=new GrokCloud(store,auth,nodes,{assertLocalVmIdle:()=>{}} as any,vi.fn(async()=>new Response('{}')))
  const agent=store.createAgent('owner',{name:'云桌面并列',profile:'default',computer:'off',envs:{vm:true,cloud:true,desktop:true}})
  expect(cloud.selected('owner',agent)).toBe(false)
  store.put('owner','grok-cloud','connection',{sealed:'x'})
  expect(cloud.selected('owner',agent)).toBe(true)
  cloud.preferDesktop=()=>true
  expect(cloud.selected('owner',agent)).toBe(true)
})

it('shares capabilities across new, legacy and helper Bots without overwriting resource bindings',()=>{
  const cloud=new GrokCloud(store,auth,nodes,{assertLocalVmIdle:()=>{}} as any,vi.fn())
  store.put('owner','grok-cloud','connection',{sealed:'fixture'})
  for(const input of [{computer:'off'},{computer:'vm',execution:'computer'},{computer:'auto'},{envs:{}},{envs:{cloud:false}}]){
    const bot=store.createAgent('owner',{name:JSON.stringify(input),profile:'default',...input})
    expect(cloud.selected('owner',bot)).toBe(true)
    expect(store.agentSummary(bot)).toMatchObject({execution:'profile',envs:{vm:true,desktop:true,cloud:true}})
  }
})
