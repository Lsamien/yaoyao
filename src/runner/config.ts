import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import type { RunnerConfiguration } from '../shared/runner.js'

const localPath=z.string().refine(value=>!value||isAbsolute(value),'路径必须为绝对路径').default('')
const schema=z.object({
  protocol:z.literal(1),serverURL:z.string().url(),runnerId:z.string().uuid(),token:z.string().min(32).max(4096),
  hermesURL:z.string().url().default('http://127.0.0.1:9119'),
  allowedProfiles:z.array(z.string().trim().min(1).max(256).regex(/^[^/\\\u0000-\u001f]+$/)).min(1).max(256),
  artifactRoots:z.array(z.string().refine(isAbsolute,'产物目录必须为绝对路径')).max(64).default([]),
  computers:z.object({managedBy:z.literal('compose').optional(),network:z.enum(['none','public-proxy']).default('none'),runtime:z.enum(['docker','podman']),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),python:localPath,hermesSource:localPath,hermesHome:localPath,maxConcurrent:z.number().int().min(1).max(8).optional()}).strict().transform(value=>{
    const hermesHome=value.hermesHome||join(homedir(),'.hermes'),hermesSource=value.hermesSource||join(hermesHome,'hermes-agent')
    return {...value,hermesHome,hermesSource,python:value.python||join(hermesSource,'venv','bin','python')}
  }).optional(),
  allowInsecureLan:z.boolean().optional(),hermesCredentials:z.object({username:z.string().max(256),password:z.string().max(4096)}).strict().optional(),
}).strict()
export function parseRunnerConfiguration(value:unknown):RunnerConfiguration {
  const parsed=schema.safeParse(value)
  if(!parsed.success)throw new Error('执行节点配置无效，请检查字段格式')
  const config=parsed.data,web=new URL(config.serverURL),hermes=new URL(config.hermesURL)
  if(web.username||web.password||web.search||web.hash||web.pathname!=='/'||!['http:','https:'].includes(web.protocol))throw new Error('夭夭服务地址无效')
  if(web.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(web.hostname)&&!config.allowInsecureLan)throw new Error('远程执行节点需要 HTTPS 或明确启用可信局域网 HTTP')
  if(hermes.username||hermes.password||hermes.search||hermes.hash||!['127.0.0.1','[::1]'].includes(hermes.hostname)||!['http:','https:'].includes(hermes.protocol))throw new Error('Runner 必须连接本机 Hermes')
  return config
}
