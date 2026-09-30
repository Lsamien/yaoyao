import { z } from 'zod'
import { HttpError } from '../errors.js'
export const website = z.object({ kind: z.literal('website'), origin: z.string().max(2000).transform((value, ctx) => {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error()
    return u.origin
  } catch { ctx.addIssue({ code: 'custom', message: '网站需要准确的 HTTPS origin' }); return z.NEVER }
}) }).strict()
export const ssh = z.object({ kind: z.literal('ssh'), host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:[\]_-]+$/).transform(v => v.toLowerCase()),
  port: z.number().int().min(1).max(65535), hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/) }).strict()
export const target = z.discriminatedUnion('kind', [website, ssh])
const path = z.string().min(2).max(1024).refine(v=>v.startsWith('/')&&!v.includes('\\')&&!/[\u0000-\u001f\u007f?#]/.test(v)&&v.split('/').every((s,i)=>i===0||!!s&&s!=='.'&&s!=='..'))
const name = z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/)
const form = z.object({kind:z.literal('website.form'),loginPath:path,submitPath:path,successPath:path,logoutPath:path.optional(),formId:name,usernameName:name,passwordName:name,
  successSelector:z.string().min(1).max(256).regex(/^(#[A-Za-z][A-Za-z0-9_-]*|\[data-[a-z0-9-]+(?:="[A-Za-z0-9_-]+")?\])$/)}).strict()
const command = z.object({kind:z.literal('ssh.exec'),command:z.string().max(512).regex(/^\/[A-Za-z0-9_/-]+$/).refine(v=>!v.includes('//')&&!v.endsWith('/'))}).strict()
const read = z.object({kind:z.literal('sftp.read'),remotePath:path,maxBytes:z.number().int().min(1).max(1048576).default(65536)}).strict()
const write = z.object({kind:z.literal('sftp.write'),remotePath:path,contents:z.string().max(65536)}).strict()
export const usage = z.discriminatedUnion('kind',[form,command,read,write])
const updatedUsage = z.discriminatedUnion('kind',[form,command,read,write.extend({contents:z.string().max(65536).optional()})])
export const leaseInput = z.object({
  credentialRef: z.string().uuid(), agentId: z.string().uuid(), workId: z.string().uuid(),
  runnerId: z.string().uuid(), runnerInstance: z.string().uuid(), runnerEpoch: z.string().min(1).max(128),
  operation: z.enum(['website.login', 'ssh.exec', 'sftp.read', 'sftp.write']), target,
  seconds: z.number().int().min(15).max(120).default(60),
}).strict()
export type LeaseInput = z.infer<typeof leaseInput>
export const entryInput = z.object({ name: z.string().trim().min(1).max(120), username: z.string().min(1).max(256),
  target, usage:usage.optional(), secret: z.string().min(1).max(32768), passphrase: z.string().max(4096).optional() }).strict()
export const updateInput = entryInput.extend({ secret: entryInput.shape.secret.optional(), usage:updatedUsage.optional(), revision: z.number().int().positive() })
export const storedEntry = entryInput.extend({ id: z.string().uuid(), revision: z.number().int().positive(), updatedAt: z.number().int().nonnegative() })
export type VaultEntry = z.infer<typeof storedEntry>
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, '密码库请求格式无效', 'vault_invalid_request')
  return result.data
}
export function masterPassword(value: unknown): string {
  return parse(z.string().min(12).max(1024), value)
}
