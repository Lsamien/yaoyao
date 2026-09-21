import {it,expect} from 'vitest'
import {personaSection} from '../../src/shared/workspace'
const base={job:undefined,antiJobs:undefined,voice:undefined,voiceCustom:undefined,actBias:undefined}
it('returns empty when no persona field is set',()=>{
 expect(personaSection(base)).toBe('')
})
it('composes job, anti-jobs, preset voice and act bias',()=>{
 const text=personaSection({...base,job:'盯家庭邮箱和日程',antiJobs:['绝不直接发送邮件','绝不提交表单'],voice:'concise',actBias:'ask_key_then_act'})
 expect(text).toContain('你的唯一职责：盯家庭邮箱和日程')
 expect(text).toContain('- 绝不直接发送邮件')
 expect(text).toContain('语气：简洁专业')
 expect(text).toContain('行动策略：先问关键问题即行动')
 expect(text.indexOf('唯一职责')).toBeLessThan(text.indexOf('明确不做'))
 expect(text.indexOf('明确不做')).toBeLessThan(text.indexOf('语气'))
})
it('uses the custom voice text only when provided',()=>{
 expect(personaSection({...base,voice:'custom'})).toBe('')
 expect(personaSection({...base,voice:'custom',voiceCustom:'像朋友一样随意'})).toContain('按以下要求把握语气：像朋友一样随意')
})
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkspaceStore} from '../../src/server/workspaceStore'
it('persists persona fields and clears them via null patches',()=>{
 const home=mkdtempSync(join(tmpdir(),'persona-'))
 const store=new WorkspaceStore(home)
 try{
  const agent=store.createAgent('owner',{name:'管家',instructions:'',profile:'default',job:'盯家庭日程',antiJobs:['绝不直接发送邮件'],voice:'casual',actBias:'ask_first'})
  expect(agent.job).toBe('盯家庭日程');expect(agent.antiJobs).toEqual(['绝不直接发送邮件'])
  const patched=store.updateAgent('owner',agent.id,{job:null,antiJobs:null,voice:null,voiceCustom:null,actBias:'act_now'})
  expect(patched.job).toBeUndefined();expect(patched.antiJobs).toBeUndefined();expect(patched.voice).toBeUndefined();expect(patched.actBias).toBe('act_now')
  const reloaded=store.require<import('../../src/shared/workspace').WorkspaceAgent>('owner','agent',agent.id)
  expect(reloaded.job).toBeUndefined();expect(reloaded.antiJobs).toBeUndefined();expect(reloaded.actBias).toBe('act_now')
 }finally{store.close();rmSync(home,{recursive:true,force:true})}
})
