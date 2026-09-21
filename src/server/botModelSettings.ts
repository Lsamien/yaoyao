import { z } from 'zod'
import type { BotModelSettings, ResolvedBotModelSettings } from '../shared/botModelSettings.js'
import type { GatewayTarget } from './workspaceGateway.js'
import { HttpError } from './errors.js'

const prefix = '/api/plugins/yaoyao-bot-bridge'
const id = z.string().min(1).max(512).refine(value => !/[\s"'\\\u0000-\u001f]/.test(value) && !value.startsWith('-'))
const effort = z.enum(['none','minimal','low','medium','high','xhigh','max','ultra'])
const speed = z.enum(['normal','fast','auto','cold'])
const effective = z.object({ provider: id, model: id, reasoningEffort: effort, fastMode: speed })
const resolved = z.object({ version: z.literal(1), effective, confirmationMessage: z.string().max(10000).nullable() })
const catalogue = z.object({ version: z.literal(1), defaults: effective, models: z.array(z.object({
  provider: id, model: id, name: z.string(), reasoningEfforts: z.array(effort), reasoningKnown: z.boolean(), fastModes: z.array(speed),
})) })

async function request(target: GatewayTarget, profile: string, settings?: BotModelSettings | null) {
  const response = await target.session.request(prefix + (settings === undefined ? '/model-options' : '/model-settings/resolve'), settings === undefined
    ? { search: new URLSearchParams({ profile }), cache: 'reload' }
    : { method: 'POST', body: { profile, settings }, cache: 'reload' })
  let body: any
  try { body = JSON.parse(response.body.toString()) } catch { /* fail with the versioned boundary below */ }
  if (response.status === 404 || response.status === 405) throw new HttpError(409, '请升级夭夭工具桥并重启 Hermes，当前版本尚不支持 Bot 模型设置。', 'model_settings_upgrade_required')
  if (response.status !== 200) throw new HttpError(response.status === 400 ? 400 : 503, typeof body?.detail === 'string' ? body.detail : 'Bot 模型服务暂不可用，请重试。', 'model_settings_unavailable')
  return body
}
export async function botModelOptions(target: GatewayTarget, profile: string) {
  const parsed = catalogue.safeParse(await request(target, profile))
  if (!parsed.success) throw new HttpError(409, '工具桥模型目录格式不兼容，请升级工具桥。', 'model_settings_upgrade_required')
  return parsed.data
}
export async function resolveBotModelSettings(target: GatewayTarget, profile: string, settings: BotModelSettings | null) {
  const parsed = resolved.safeParse(await request(target, profile, settings))
  if (!parsed.success) throw new HttpError(409, '工具桥模型配置格式不兼容，请升级工具桥。', 'model_settings_upgrade_required')
  return parsed.data
}
export const botModelTarget = (value: Pick<ResolvedBotModelSettings, 'provider' | 'model'>) => JSON.stringify([value.provider, value.model])
export class BotModelConfirmationError extends HttpError {
  constructor(readonly target: string, readonly confirmationMessage: string) {
    super(409, '此模型需要确认，请打开 Bot 个人资料重新保存模型设置。', 'model_confirmation_required')
  }
}

/** Always applied to an idle session; acknowledgements precede prompt submission. */
export async function applyBotModelSettings(
  rpc: (method: string, params: Record<string, unknown>) => Promise<any>, sessionId: string,
  value: ResolvedBotModelSettings, confirmed: boolean,
  current?: { model?: string; provider?: string },
) {
  for (const [key, input] of [['model', `${value.model} --provider ${value.provider} --session`], ['reasoning', value.reasoningEffort], ['fast', value.fastMode]]) {
    if (key === 'model' && current?.model === value.model && current?.provider === value.provider) continue
    const result = await rpc('config.set', { session_id: sessionId, key, value: input, scope: 'session', ...(key === 'model' && confirmed ? { confirm_expensive_model: true } : {}) })
    if (result?.confirm_required) throw new BotModelConfirmationError(botModelTarget(value), String(result.confirm_message || result.warning || '此会话切换模型可能增加费用，请确认继续。').slice(0, 10000))
    if (result?.deferred || (key === 'model' && result?.scope !== 'session') || result?.value !== (key === 'model' ? value.model : input)) throw new HttpError(502, 'Hermes 未确认 Bot 会话模型设置，本轮未发送，请检查模型服务后重试。', 'model_settings_not_applied')
  }
}
