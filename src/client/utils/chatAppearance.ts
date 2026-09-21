export type BubbleRole = 'user' | 'assistant'
export type BubblePreset = 'current' | 'grok' | 'codex'
export interface BubbleStyle {
  light: string
  dark: string
  lightEnd: string
  darkEnd: string
  lightText: string
  darkText: string
  gradient: boolean
  radius: number
  border: boolean
  tail: boolean
}
export interface ChatAppearance {
  version: 1
  preset: BubblePreset | 'custom'
  user: BubbleStyle
  assistant: BubbleStyle
}
export const bubblePresets = [
  { id: 'current', name: '当前样式', detail: '经典蓝灰' },
  { id: 'grok', name: 'Grok Bot', detail: '黑白灰' },
  { id: 'codex', name: 'Codex', detail: '浅蓝双气泡' },
] as const
export const bubbleSwatches = ['#090909', '#2868D7', '#26BFAE', '#9370DB', '#E56A92', '#F59742', '#A2A5AF']

function style(light: string, dark: string, lightText: string, darkText: string, radius = 18, tail = false): BubbleStyle {
  return { light, dark, lightEnd: light, darkEnd: dark, lightText, darkText, radius, tail, gradient: false, border: false }
}
export function appearancePreset(id: BubblePreset): ChatAppearance {
  const assistant = style('#F1F1F1', '#262626', '#202124', '#F4F4F5', id === 'codex' ? 18 : 20, id === 'current')
  const user = id === 'grok' ? style('#090909', '#5A5A5A', '#FFFFFF', '#FFFFFF', 20)
    : id === 'codex' ? style('#E4F3FC', '#203C50', '#1E69A5', '#C1E5FF')
      : style('#2868D7', '#2868D7', '#FFFFFF', '#FFFFFF', 20, true)
  return { version: 1, preset: id, user, assistant }
}
export function validHex(value: unknown): value is string { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) }
export function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
export function automaticText(start: string, end = start): string {
  const white = Math.min(contrast(start, '#FFFFFF'), contrast(end, '#FFFFFF'))
  const black = Math.min(contrast(start, '#141414'), contrast(end, '#141414'))
  return white > black ? '#FFFFFF' : '#141414'
}
export function normalizeAppearance(value: unknown): ChatAppearance {
  const fallback = appearancePreset('current')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const raw = value as Partial<ChatAppearance>
  if (raw.version !== 1) return fallback
  const preset = bubblePresets.find(p => p.id === raw.preset)
  // Presets are canonical; ignore stale/custom fields stored alongside an id.
  if (preset) return appearancePreset(preset.id)
  if (raw.preset !== 'custom') return fallback
  for (const role of ['user', 'assistant'] as const) {
    const item = raw[role]
    if (!item || !['light', 'dark', 'lightEnd', 'darkEnd'].every(k => validHex(item[k as keyof BubbleStyle]))) return fallback
    const base = fallback[role]
    fallback[role] = {
      ...base, light: item.light.toUpperCase(), dark: item.dark.toUpperCase(),
      lightEnd: item.lightEnd.toUpperCase(), darkEnd: item.darkEnd.toUpperCase(),
      lightText: validHex(item.lightText) ? item.lightText : automaticText(item.light, item.gradient ? item.lightEnd : item.light),
      darkText: validHex(item.darkText) ? item.darkText : automaticText(item.dark, item.gradient ? item.darkEnd : item.dark),
      gradient: item.gradient === true, border: item.border === true, tail: item.tail === true,
      radius: typeof item.radius === 'number' && Number.isFinite(item.radius) ? Math.max(4, Math.min(28, item.radius)) : base.radius,
    }
  }
  fallback.preset = 'custom'
  return fallback
}
export function bubbleColors(value: BubbleStyle, dark: boolean) {
  const start = dark ? value.dark : value.light
  const end = value.gradient ? dark ? value.darkEnd : value.lightEnd : start
  const preferred = dark ? value.darkText : value.lightText
  const text = Math.min(contrast(start, preferred), contrast(end, preferred)) >= 4.5 ? preferred : automaticText(start, end)
  const needsScrim = Math.min(contrast(start, text), contrast(end, text)) < 4.5
  const gradient = `linear-gradient(135deg, ${start}, ${end})`
  // A contrasting scrim protects text even across extreme custom gradients.
  const scrim = text === '#FFFFFF' ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.8)'
  return { text, background: needsScrim ? `linear-gradient(${scrim}, ${scrim}), ${gradient}` : value.gradient ? gradient : start }
}
export function bubbleVariables(value: BubbleStyle, role: BubbleRole): Record<string, string> {
  const light = bubbleColors(value, false), dark = bubbleColors(value, true)
  const radius = `${value.radius}px`
  return {
    '--bubble-light': light.background, '--bubble-dark': dark.background,
    '--bubble-light-text': light.text, '--bubble-dark-text': dark.text,
    '--bubble-radius': value.tail ? role === 'user' ? `${radius} ${radius} 4px ${radius}` : `${radius} ${radius} ${radius} 4px` : radius,
    '--bubble-border': value.border ? '1px solid color-mix(in srgb, currentColor 24%, transparent)' : '1px solid transparent',
  }
}
