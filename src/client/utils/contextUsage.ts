import type { ChatUsage, JsonValue } from '@shared/types'
import { record } from './normalize'

/** Match mobile: context is the latest prompt occupancy, never cumulative usage
 * or the full (possibly compacted/paginated) visible transcript. */
export function normalizeChatUsage(...sources: unknown[]): ChatUsage | undefined {
  const fields: [Exclude<keyof ChatUsage, 'raw'>, string[]][] = [
    ['inputTokens', ['input_tokens', 'inputTokens', 'input', 'prompt']],
    ['outputTokens', ['output_tokens', 'outputTokens', 'output', 'completion']],
    ['totalTokens', ['total_tokens', 'totalTokens', 'total']],
    ['contextTokens', ['context_used', 'contextUsed', 'context_tokens', 'contextTokens']],
    ['contextLimit', ['context_max', 'contextMax', 'context_limit', 'contextLimit', 'context_length', 'contextLength', 'effective_context_length']],
    ['percentUsed', ['context_percent', 'contextPercent', 'percent_used', 'percentUsed']],
  ]
  const usage: ChatUsage = {}
  for (const source of sources) {
    const root = record(source)
    for (const value of [record(root.usage), record(record(root.info).usage), root, record(root.info)]) {
      for (const [field, aliases] of fields) {
        if (usage[field] !== undefined) continue
        for (const alias of aliases) {
          const raw = value[alias]
          if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) continue
          const number = Number(raw)
          if (!Number.isFinite(number) || number < 0 || (field === 'contextLimit' && number === 0)) continue
          usage[field] = number
          break
        }
      }
    }
  }
  return Object.keys(usage).length ? { ...usage, raw: sources[0] as JsonValue } : undefined
}
