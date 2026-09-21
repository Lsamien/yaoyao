export type BotFastMode = 'normal' | 'fast' | 'auto' | 'cold'
export interface BotModelSettings {
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  fastMode: BotFastMode | null
}
export interface ResolvedBotModelSettings {
  provider: string
  model: string
  reasoningEffort: string
  fastMode: BotFastMode
}
export interface BotModelOption {
  provider: string
  model: string
  name: string
  reasoningEfforts: string[]
  reasoningKnown: boolean
  fastModes: BotFastMode[]
}
export interface BotModelOptions {
  version: 1
  defaults: ResolvedBotModelSettings
  models: BotModelOption[]
  settings: BotModelSettings | null
  revision: number
}
export const inheritedBotModelSettings = (): BotModelSettings => ({ provider: null, model: null, reasoningEffort: null, fastMode: null })
export const botReasoningLabels: Record<string, string> = { none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: 'Ultra' }
export const botFastLabels: Record<BotFastMode, string> = { normal: '普通', fast: '快速', auto: '每轮开始加速', cold: '首次回复加速' }
