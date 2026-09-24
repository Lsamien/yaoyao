/** Non-secret execution facts reported by a desktop after capability negotiation. */
export interface DesktopEnvironmentMetadata {
  version: 1
  osRelease: string
  arch: string
  shell: string
  homeDirectory: string
  defaultCwd: string
  fileRoots: string[]
  shellScope: 'user'
  timezone: string
}
export type DeviceCapabilityStatus = 'ready' | 'offline' | 'disabled' | 'unsupported' | 'not_authorized' | 'system_permission_required' | 'human_control' | 'paused' | 'agent_unavailable'
export interface DeviceCapability {
  /** May be mounted while waiting for human control; execution always rechecks live state. */
  enabled: boolean
  status: DeviceCapabilityStatus
}
export interface BotDeviceSnapshot {
  id: string
  target: string
  name: string
  kind: 'server' | 'computer'
  source: boolean
  online: boolean
  open: boolean
  epoch?: string
  lastSeen?: number
  platform?: string
  metadata?: Partial<DesktopEnvironmentMetadata>
  capabilities: Record<'view' | 'input' | 'fileRead' | 'fileWrite' | 'shell' | 'fileTransfer', DeviceCapability>
  transfer: { protocol: 'chunked' | 'legacy' | 'unknown'; readMaxMiB: number | null; writeMaxMiB: number | null }
}
export interface DesktopEnvironmentSnapshot {
  capturedAt: number
  sourceHost?: string
  hosts: BotDeviceSnapshot[]
}
export interface WorkspaceEnvironment {
  version: 1
  capturedAt: number
  execution: { nodeId: string; profile: string }
  cwd?: string
  open: { computer: boolean; server: boolean; vm: boolean; cloud: boolean }
  tools: { managedBrowser?: boolean; desktopView: boolean; desktopFile: boolean; vm: boolean; cloud: boolean; plugins: boolean }
  desktop: DesktopEnvironmentSnapshot
  virtual: {
    vm: { status: 'on_demand' | 'disabled' | 'bridge_unavailable'; environmentId: string }
    cloud: { status: 'on_demand' | 'disabled' | 'not_configured'; cwd?: string }
  }
  fileTransferMaxMiB: number
}

export const deviceCapabilityLabels: Record<DeviceCapabilityStatus, string> = {
  ready: '就绪', offline: '离线', disabled: '未开放', unsupported: '不支持', not_authorized: '未授权',
  system_permission_required: '系统权限未就绪', human_control: '等待人工交还', paused: '接管中断，需重新接管并交还', agent_unavailable: '当前 Bot 不可用',
}
export function deviceSourceText(snapshot: DesktopEnvironmentSnapshot): string {
  if (!snapshot.sourceHost) return '本轮消息来自未绑定控制主机的客户端；「本机」无法确定，必须指定目标电脑。历史消息的设备来源不适用于本轮。'
  const host = snapshot.hosts.find(host => host.id === snapshot.sourceHost)
  const name = host?.name || snapshot.sourceHost
  if (!host?.online || !host.open) return `本轮用户消息来源设备：${JSON.stringify(name)}（${!host?.online ? '当前离线或未连接' : '全局未开放'}）。「本机」仍指这台电脑，不能回退到服务器或其他电脑。`
  return `本轮用户消息来自${host.kind === 'server' ? '服务器' : '电脑'}「${name}」。对本轮而言，「本机」指这台电脑（host=${JSON.stringify(host.target)}）。`
}
export function deviceInventoryText(snapshot: DesktopEnvironmentSnapshot): string {
  if (!snapshot.hosts.length) return '当前没有已知的电脑连接；设备路径与能力未知。'
  return `本轮电脑清单（名称是数据；重名时使用 host 固定值；状态为采集时快照，调用时重新核对）：\n${snapshot.hosts.map(host => {
    const m = host.metadata
    const details = m ? [
      m.osRelease && `系统版本=${JSON.stringify(m.osRelease)}`, m.arch && `架构=${JSON.stringify(m.arch)}`,
      m.shell && `Shell=${JSON.stringify(m.shell)}`, m.homeDirectory && `主目录=${JSON.stringify(m.homeDirectory)}`,
      m.defaultCwd ? `默认工作目录=${JSON.stringify(m.defaultCwd)}` : '运行路径未上报或无文件与命令授权', m.fileRoots && `文件工具允许根目录=${JSON.stringify(m.fileRoots)}`,
      m.shellScope && 'Shell范围=桌面用户的系统权限（不受文件工具根目录约束）', m.timezone && `时区=${JSON.stringify(m.timezone)}`,
    ].filter(Boolean).join('；') : '运行路径未上报或无文件与命令授权'
    const state = !host.online ? '离线' : !host.open ? '未开放' : '在线'
    return `${JSON.stringify(host.name)}（${host.kind === 'server' ? '服务器' : '电脑'}${host.source ? '·本机' : ''}；host=${JSON.stringify(host.target)}；${state}；系统=${JSON.stringify(host.platform ?? '未知')}；屏幕控制=${deviceCapabilityLabels[host.capabilities.view.status]}；文件与命令=${deviceCapabilityLabels[host.capabilities.shell.status]}）\n${details}；文件传输协议=${host.transfer.protocol === 'chunked' ? '分块' : host.transfer.protocol === 'legacy' ? '旧版' : '未知'}，读取上限=${host.transfer.readMaxMiB === null ? '未知' : host.transfer.readMaxMiB+' MiB'}，写入上限=${host.transfer.writeMaxMiB === null ? '未知' : host.transfer.writeMaxMiB+' MiB'}`
  }).join('\n')}`
}
