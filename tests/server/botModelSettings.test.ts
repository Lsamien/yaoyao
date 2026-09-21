// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore, botModelSettingsInput } from '../../src/server/workspaceStore'
import { applyBotModelSettings, botModelOptions, resolveBotModelSettings } from '../../src/server/botModelSettings'
import type { GatewayTarget } from '../../src/server/workspaceGateway'
import type { WorkspaceAgent } from '../../src/shared/workspace'
import { inheritedBotModelSettings } from '../../src/shared/botModelSettings'

let home: string, store: WorkspaceStore
const settings = { provider: 'openai', model: 'model-b', reasoningEffort: 'high', fastMode: 'auto' as const }
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bot-model-')); store = new WorkspaceStore(home) })
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }) })
it('persists per-Bot settings, preserves old-client patches, and rejects stale edits atomically', () => {
  const a = store.createAgent('owner', { name: '甲', profile: 'default' }), b = store.createAgent('owner', { name: '乙', profile: 'default' })
  const updated = store.updateAgent('owner', a.id, { modelSettings: settings, expectedRevision: a.revision })
  store.updateAgent('owner', a.id, { name: '新名字' })
  expect(store.require<WorkspaceAgent>('owner','agent',a.id).modelSettings).toEqual(settings)
  expect(store.require<WorkspaceAgent>('owner','agent',b.id).modelSettings).toBeUndefined()
  expect(() => store.updateAgent('owner', a.id, { modelSettings: null, expectedRevision: updated.revision })).toThrow('已在其他地方更新')
  const current = store.require<WorkspaceAgent>('owner','agent',a.id)
  store.updateAgent('owner', a.id, { modelSettings: null, expectedRevision: current.revision })
  store.close(); store = new WorkspaceStore(home)
  expect(store.require<WorkspaceAgent>('owner','agent',a.id).modelSettings).toBeNull()
})
it('distinguishes inherited values, explicit no reasoning, and all four speed modes', () => {
  for (const fastMode of ['normal','fast','auto','cold']) expect(botModelSettingsInput.parse({ ...inheritedBotModelSettings(), reasoningEffort:'none', fastMode }).fastMode).toBe(fastMode)
  for (const invalid of [{...settings,model:null},{...settings,fastMode:true},{...settings,model:'model --global'}]) expect(botModelSettingsInput.safeParse(invalid).success).toBe(false)
})
it('applies and checks model, reasoning, speed in order using session scope only', async () => {
  const rpc = vi.fn(async (_method, params) => ({ value: params.key === 'model' ? 'model-b' : params.value, scope:'session' }))
  await applyBotModelSettings(rpc, 'session-a', settings, false)
  expect(rpc.mock.calls.map(([,p]) => p.key)).toEqual(['model','reasoning','fast'])
  for (const [method, params] of rpc.mock.calls) { expect(method).toBe('config.set'); expect(params).toMatchObject({ session_id:'session-a',scope:'session' }) }
  expect(rpc.mock.calls[0]![1].value).toBe('model-b --provider openai --session')
})
it.each([{ value:'wrong',scope:'session' }, { value:'model-b',scope:'global' }, { value:'model-b',deferred:true }, { confirm_required:true }])('never submits downstream changes without an immediate acknowledgement: %j', async response => {
  const rpc = vi.fn().mockResolvedValue(response)
  await expect(applyBotModelSettings(rpc,'session-a',settings,false)).rejects.toThrow()
  expect(rpc).toHaveBeenCalledTimes(1)
})
it('avoids rebuilding an unchanged model and still replaces old reasoning and speed pins', async () => {
  const rpc = vi.fn(async (_method, params) => ({value:params.value}))
  await applyBotModelSettings(rpc,'session-a',{...settings,reasoningEffort:'none',fastMode:'normal'},false,settings)
  expect(rpc.mock.calls.map(([,p])=>[p.key,p.value])).toEqual([['reasoning','none'],['fast','normal']])
})
it('rejects old bridges and malformed catalogues and resolves inherited values through the bridge', async () => {
  const request = vi.fn().mockResolvedValue({status:404,body:Buffer.from('{}')})
  const target = {session:{request}} as unknown as GatewayTarget
  await expect(botModelOptions(target,'default')).rejects.toMatchObject({code:'model_settings_upgrade_required'})
  request.mockResolvedValue({status:200,body:Buffer.from(JSON.stringify({version:1,effective:settings,confirmationMessage:null}))})
  expect((await resolveBotModelSettings(target,'default',null)).effective).toEqual(settings)
  expect(request.mock.lastCall).toEqual(['/api/plugins/yaoyao-bot-bridge/model-settings/resolve',{method:'POST',body:{profile:'default',settings:null},cache:'reload'}])
  await expect(botModelOptions(target,'default')).rejects.toMatchObject({code:'model_settings_upgrade_required'})
})
