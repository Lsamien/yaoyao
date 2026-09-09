// @vitest-environment node
import {expect,it,vi} from 'vitest'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {ComputerControlService} from '../../src/server/computerControls'
import {HttpError} from '../../src/server/errors'
import type {LocalAuthStore} from '../../src/server/localAuth'
import type {RunnerHub} from '../../src/server/runnerHub'
it('returns a private control credential once, rejects other callers and invalidates revoked grants',async()=>{
  const home=mkdtempSync(join(tmpdir(),'yaoyao-control-routes-')),store=new WorkspaceStore(home),runnerId=randomUUID()
  let authVersion=1
  const auth={require:(ctx:any)=>({id:ctx.get('x-fixture-owner')||'owner'}),pushAuthorizationVersion:()=>authVersion} as unknown as LocalAuthStore
  const nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any)
  const calls=vi.fn(async(_owner,_agent,op,_data,authorize)=>{authorize();return {mode:op==='take'?'pausing':'agent'}})
  const hub={computerRunner:()=>({id:runnerId}),computer:calls} as unknown as RunnerHub
  const service=new ComputerControlService(store,auth,nodes,hub),app=new Koa()
  app.use(async(ctx,next)=>{try{await next()}catch(error){ctx.status=error instanceof HttpError?error.status:500;ctx.body={code:(error as any).code}}});app.use(bodyParser());app.use(service.router().routes())
  try{
    const agent=store.createAgent('owner',{name:'电脑',profile:'default',execution:'computer'}),base=`/api/app/agents/${agent.id}/computer`
    const taken=await request(app.callback()).post(base+'/take').send({requestId:randomUUID()}).expect(200)
    expect(taken.body.token.length).toBeGreaterThan(32)
    expect(JSON.stringify((await request(app.callback()).get(base).expect(200)).body)).not.toContain(taken.body.token)
    expect(service.allowed(taken.body.controlId,runnerId)).toBe(true)
    await request(app.callback()).post(base+'/renew').send({controlId:taken.body.controlId,token:'x'.repeat(40)}).expect(403)
    await request(app.callback()).post(base+'/renew').set('x-fixture-owner','other').send({controlId:taken.body.controlId,token:taken.body.token}).expect(403)
    await request(app.callback()).post(base+'/take').send({requestId:randomUUID()}).expect(409)
    authVersion++
    expect(service.allowed(taken.body.controlId,runnerId)).toBe(false)
    await request(app.callback()).post(base+'/renew').send({controlId:taken.body.controlId,token:taken.body.token}).expect(410)
  }finally{nodes.close();store.close();rmSync(home,{recursive:true,force:true})}
})
