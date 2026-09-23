/** Platform policy is shared by startup, native menus and the renderer bridge. */
export function desktopPlatform(platform = process.platform) {
  return Object.freeze({ platform, server: platform === 'darwin',
    supportedModes: platform === 'darwin' ? ['client', 'server'] : ['client'],
    computer: ['darwin', 'win32'].includes(platform), windows: platform === 'win32' })
}

export function loginItemOptions(platform = process.platform, executable = process.execPath) {
  return platform === 'win32' ? { path: executable, args: ['--yaoyao-login'] } : {}
}

export function desktopMenu(template, platform = process.platform) {
  if (platform === 'darwin') return template
  const excluded = new Set(['desktop-local-vm', 'desktop-sync-notice', 'desktop-sync-retry',
    'desktop-sync-force', 'desktop-stop-and-quit', 'desktop-host-use-local', 'desktop-host-ask'])
  const result = []
  for (const item of template) {
    if (excluded.has(item.id) || item.label === '执行节点' || ['hide', 'hideOthers', 'unhide'].includes(item.role)) continue
    const next = { ...item }
    if (next.submenu) next.submenu = desktopMenu(next.submenu, platform)
    if (next.id === 'desktop-login') next.label = '登录 Windows 时启动'
    if (next.id === 'desktop-background') next.label = '登录启动时仅驻留托盘'
    if (next.id === 'desktop-service-status') next.label = '尚未连接服务器'
    if (next.label === '退出夭夭（后台继续运行）') next.label = '退出夭夭'
    if (next.label === '停止后台服务并退出') continue
    if (next.type === 'separator' && (!result.length || result.at(-1).type === 'separator')) continue
    result.push(next)
  }
  if (result.at(-1)?.type === 'separator') result.pop()
  return result
}
