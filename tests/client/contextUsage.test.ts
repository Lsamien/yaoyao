import { describe, expect, it } from 'vitest'
import { normalizeChatUsage } from '@/utils/contextUsage'

describe('context usage shared by web and desktop', () => {
  it('never treats cumulative billing or an output limit as context occupancy', () => {
    const usage = normalizeChatUsage({ input_tokens: 1_800_000, output_tokens: 100_000,
      total_tokens: 1_900_000, max_tokens: 262_144, used: 1_900_000, limit: 262_144 })
    expect(usage).toMatchObject({ inputTokens: 1_800_000, outputTokens: 100_000, totalTokens: 1_900_000 })
    expect(usage?.contextTokens).toBeUndefined()
    expect(usage?.contextLimit).toBeUndefined()
  })

  it('uses the same last-prompt source order and server percentage as mobile', () => {
    const usage = normalizeChatUsage({ usage: { context_used: 2000, context_max: 8000, context_percent: 45.5 } },
      { context_used: 3000, context_max: 16000 })
    expect(usage).toMatchObject({ contextTokens: 2000, contextLimit: 8000, percentUsed: 45.5 })
  })

  it('fills missing gauges from context breakdown without using cumulative totals', () => {
    expect(normalizeChatUsage({ total: 1_900_000 }, { context_used: 12_500, context_max: 114_688 }))
      .toMatchObject({ totalTokens: 1_900_000, contextTokens: 12_500, contextLimit: 114_688 })
  })

  it('recognizes nested session metadata and camel-case context fields', () => {
    expect(normalizeChatUsage({ info: { usage: { contextUsed: 2000, contextMax: 8000, contextPercent: 0 } } }))
      .toMatchObject({ contextTokens: 2000, contextLimit: 8000, percentUsed: 0 })
    expect(normalizeChatUsage({ contextTokens: 2000, contextLimit: 8000 }))
      .toMatchObject({ contextTokens: 2000, contextLimit: 8000 })
  })

  it('preserves an explicit reset to zero and ignores missing or invalid measurements', () => {
    expect(normalizeChatUsage({ context_used: 0, context_percent: 0, total: 1_900_000 }))
      .toMatchObject({ contextTokens: 0, percentUsed: 0 })
    expect(normalizeChatUsage({ text: '完成', context_used: -1, context_max: 0, context_percent: Number.NaN }))
      .toBeUndefined()
    expect(normalizeChatUsage(undefined, {})).toBeUndefined()
  })
})
