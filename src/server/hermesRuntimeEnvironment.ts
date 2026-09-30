import { z } from 'zod'
import type { HermesRuntimeMetadata } from '../shared/botEnvironment.js'

const text = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value))
const tools = z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).max(256)
const metadata = z.object({
  version: z.literal(1), profile: text, platform: text, osRelease: text, arch: text,
  nativeTools: z.object({ terminal: tools, files: tools, desktop: tools, browser: tools }),
})

/** Optional protocol extension: old or incompatible bridges leave facts unknown. */
export function parseHermesRuntimeMetadata(value: unknown, profile: string): HermesRuntimeMetadata | undefined {
  const parsed = metadata.safeParse(value)
  if (!parsed.success || parsed.data.profile !== profile) return undefined
  return parsed.data
}
