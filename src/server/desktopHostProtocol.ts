import { z } from 'zod'

const text = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]*$/)
export const desktopHostEnvironmentSchema = z.object({
  version: z.literal(1), osRelease: text, arch: text, shell: text,
  homeDirectory: text, defaultCwd: text, fileRoots: z.array(text).min(1).max(8),
  shellScope: z.literal('user'), timezone: text,
}).strict()
export const desktopHostInfoSchema = z.object({
  id: z.string().uuid(), name: z.string().max(128), platform: z.string().max(16),
  screen: z.boolean(), accessibility: z.boolean(), approved: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100),
  full: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100).optional(),
  fileTransferVersion: z.literal(1).optional(), environment: desktopHostEnvironmentSchema.optional(),
}).strict()
export const desktopHostExchangeSchema = z.object({
  host: desktopHostInfoSchema,
  results: z.array(z.object({ id: z.string().uuid(), value: z.unknown().optional(), error: z.string().max(500).optional() }).strict()).max(20),
}).strict()
