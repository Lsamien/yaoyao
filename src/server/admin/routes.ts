/**
 * Which API routes belong to the admin console. Both listeners use this table:
 * the user Web (15300) answers these with 410, and the admin console (15301)
 * serves only these plus a few read endpoints its panels share with the Web.
 */

const READ = new Set(['GET', 'HEAD'])

/** Management and system settings: only on the admin console. */
export function isManagementRoute(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (/^\/api\/app\/(?:admin|system)(?:\/|$)/.test(path)) return true
  // Grok cloud sign-in links the shared cloud computer; status and disconnect stay with the Bot panel.
  if (path === '/api/app/grok-cloud/connect' || /^\/api\/app\/grok-cloud\/auth\/(?:start|[^/]+\/(?:poll|cancel))$/.test(path)) return true
  if (path === '/api/app/desktop-environment' || path.startsWith('/api/app/desktop-environment/')) return true
  if (/^\/api\/app\/agents\/[^/]+\/desktop-environment\/authorize$/.test(path)) return true
  if (path === '/api/app/voice/probe') return true
  // Paired child nodes: listing and editing are management; a Bot still reads a node's agents.
  if (path === '/api/app/nodes' || /^\/api\/app\/nodes\/[^/]+$/.test(path)) return true
  // Shared settings: everyone reads them, only the console writes them.
  if (!READ.has(verb) && ['/api/app/server-identity', '/api/app/settings/file-access', '/api/app/settings/host-tools'].includes(path)) return true
  return false
}

/** User endpoints the console panels also read (model catalog, push capability, current settings). */
export function isConsoleSupportRoute(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (path === '/api/app/grok-cloud/auth') return verb === 'GET' || verb === 'HEAD' || verb === 'DELETE'
  if (!READ.has(verb)) return false
  return path === '/api/app/models'
    || path === '/api/app/computers'
    || path === '/api/app/capabilities'
    || path === '/api/app/server-identity'
    || path === '/api/app/settings/file-access'
    || path === '/api/app/settings/host-tools'
    || path === '/api/app/push/v1/capabilities'
}

/** Console session endpoints, defined by the admin console itself. */
export const CONSOLE_PREFIX = '/api/app/console'

/** Module label for the audit log, derived from the route. */
export function auditModule(path: string): string {
  const rules: Array<[RegExp, string]> = [
    [/^\/api\/app\/console\//, '后台登录'],
    [/^\/api\/app\/admin\/users/, '用户与权限'],
    [/^\/api\/app\/admin\/(?:model-services|legacy-model-services|hermes|profiles)|^\/api\/app\/grok-cloud/, '模型服务'],
    [/^\/api\/app\/admin\/execution|^\/api\/app\/settings\/(?:host-tools|file-access)/, '执行与权限'],
    [/^\/api\/app\/admin\/(?:desktop-hosts|runners)|^\/api\/app\/desktop-environment|^\/api\/app\/agents\/[^/]+\/desktop-environment/, '电脑与设备'],
    [/^\/api\/app\/admin\/local-vm/, '本地虚拟机'],
    [/^\/api\/app\/admin\/openviking/, '记忆服务'],
    [/^\/api\/app\/system\/push/, '消息推送'],
    [/^\/api\/app\/admin\/duplex-voice|^\/api\/app\/voice/, '语音'],
    [/^\/api\/app\/system\/allowed-hosts|^\/api\/app\/server-identity|^\/api\/app\/nodes/, '网络与安全'],
    [/^\/api\/app\/system\/update/, '更新与回滚'],
  ]
  return rules.find(([pattern]) => pattern.test(path))?.[1] ?? '其他'
}
