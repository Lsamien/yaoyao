import { test } from 'node:test'
import assert from 'node:assert/strict'
import { desktopPlatform, desktopMenu, loginItemOptions, clientOnlyRuntime } from './platform.mjs'
import { DesktopOnboarding } from './onboarding.mjs'
import { hostPathInput, pathInside } from '../src/shared/hostPaths.mjs'

test('Windows can only connect to a server, including direct onboarding calls', () => {
  const platform = desktopPlatform('win32')
  assert.deepEqual(platform.supportedModes, ['client'])
  const onboarding = new DesktopOnboarding({ ...platform, remoteServer: () => '' })
  assert.equal(onboarding.snapshot().mode, 'remote')
  assert.equal(onboarding.snapshot().platform, 'win32')
  assert.throws(() => onboarding.select('local'), /不支持/)
  assert.throws(() => onboarding.open({ mode: 'local' }), /不支持/)
  assert.equal(onboarding.select('remote').mode, 'remote')
  assert.deepEqual(desktopPlatform('darwin').supportedModes, ['client', 'server'])
})
test('a client-only macOS build follows the Windows client policy', () => {
  const platform = desktopPlatform('darwin', { clientOnly: true })
  assert.equal(platform.server, false)
  assert.deepEqual(platform.supportedModes, ['client'])
  assert.equal(platform.computer, true, 'remote computer control stays available')
  const onboarding = new DesktopOnboarding({ ...platform, remoteServer: () => '' })
  assert.equal(onboarding.snapshot().mode, 'remote')
  assert.throws(() => onboarding.select('local'), /不支持/)
  assert.equal(onboarding.select('remote').mode, 'remote')
  assert.deepEqual(desktopPlatform('darwin').supportedModes, ['client', 'server'], 'default darwin policy is untouched')
})
test('client-only macOS menus omit local service actions but keep remote login and quit', () => {
  const template = [{ label: '夭夭', submenu: [
    { role: 'about', label: '关于夭夭' }, { type: 'separator' },
    { id: 'desktop-service-status', label: '正在连接后台服务…', enabled: false },
    { id: 'desktop-local-vm', label: '本地虚拟机设置…' },
    { id: 'desktop-background', label: '登录启动时仅驻留菜单栏', type: 'checkbox' },
    { id: 'desktop-login', label: '登录 macOS 时启动', type: 'checkbox' },
    { id: 'desktop-quit', label: '退出夭夭（后台继续运行）' },
    { id: 'desktop-stop-and-quit', label: '停止后台服务并退出' }] },
    { label: '执行节点', submenu: [{ id: 'runner-import' }] },
    { label: '运行模式', submenu: [{ id: 'desktop-host-use-local' }, { id: 'desktop-host-ask' }, { label: '更换服务器…' }] },
    { label: '电脑', submenu: [{ id: 'desktop-host-authorize' }] },
    { role: 'editMenu', label: '编辑' }]
  const menus = desktopMenu(template, 'darwin', { clientOnly: true })
  assert.deepEqual(menus.map(menu => menu.label), ['夭夭', '运行模式', '电脑', '编辑'])
  const labels = menus[0].submenu.filter(item => item.type !== 'separator').map(item => item.label)
  assert.deepEqual(labels, ['关于夭夭', '尚未连接服务器', '登录启动时仅驻留菜单栏', '登录 Mac 时启动', '退出夭夭'])
  assert.deepEqual(menus[1].submenu, [{ label: '更换服务器…' }])
  assert.deepEqual(menus[2].submenu, [{ id: 'desktop-host-authorize' }])
})
test('the client-only marker is detected from the runtime root or environment override', () => {
  assert.equal(clientOnlyRuntime('/nonexistent-runtime-path'), false)
  process.env.HERMES_YAOYAO_DESKTOP_CLIENT_ONLY = '1'
  try {
    assert.equal(clientOnlyRuntime('/nonexistent-runtime-path'), true)
    assert.equal(desktopPlatform('darwin', {}).server, true, 'explicit options still decide the policy')
  } finally { delete process.env.HERMES_YAOYAO_DESKTOP_CLIENT_ONLY }
})
test('Windows menus retain useful actions and omit all local service actions', () => {
  const template = [{ label: '夭夭', submenu: [{ role: 'hide' }, { id: 'desktop-local-vm' }, { id: 'desktop-login' }, { id: 'desktop-quit', label: '退出夭夭（后台继续运行）' }] },
    { label: '执行节点', submenu: [{ id: 'runner-import' }] }, { label: '运行模式', submenu: [{ id: 'desktop-host-use-local' }, { label: '更换服务器…' }] }]
  const windows = desktopMenu(template, 'win32')
  assert.equal(windows.length, 2)
  assert.deepEqual(windows[0].submenu.map(item => item.label), ['登录 Windows 时启动', '退出夭夭'])
  assert.deepEqual(windows[1].submenu, [{ label: '更换服务器…' }])
  assert.equal(desktopMenu(template, 'darwin'), template)
  assert.deepEqual(loginItemOptions('win32', 'C:\\Apps\\Yaoyao.exe'), { path: 'C:\\Apps\\Yaoyao.exe', args: ['--yaoyao-login'] })
})
test('Windows file boundaries handle drive casing, separators, traversal and device paths', () => {
  const root = 'C:\\Users\\张三'
  for (const path of ['c:\\users\\张三\\Documents\\a.txt', 'C:/Users/张三/Desktop/a.txt', root]) assert.equal(pathInside(root, path, 'win32'), true, path)
  for (const path of ['C:\\Users\\张三2\\a.txt', 'D:\\Users\\张三\\a.txt', 'C:\\Users\\张三\\..\\secret']) assert.equal(pathInside(root, path, 'win32'), false, path)
  assert.equal(hostPathInput('~\\Documents\\中文.txt', 'win32'), 'Documents\\中文.txt')
  for (const path of ['C:secret', '\\\\server\\share', '\\\\?\\C:\\secret', 'a.txt:secret', 'CON', 'x\\NUL.txt', 'x.\\secret', 'a\0b']) assert.throws(() => hostPathInput(path, 'win32'), /路径无效/, path)
  assert.equal(hostPathInput('notes:today', 'darwin'), 'notes:today')
  assert.equal(pathInside('/home/a', '/home/ab', 'linux'), false)
})
