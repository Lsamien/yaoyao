/** The native caller chooses its own core; no host identifier comes from the page. */
export async function authorizeCurrentComputer({ scope, core, origin, cookies, fetchImpl, isCurrent }) {
  if (!['screen', 'full'].includes(scope)) throw new Error('授权范围无效')
  if (!core || core.closed) throw new Error('当前设备尚未连接，请重新登录客户端')
  const response = await fetchImpl(new URL('/api/app/desktop-environment/authorization', origin), {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { accept: 'application/json', cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') },
  })
  if (!response.ok) throw new Error(response.status === 403 ? '请使用管理员账号授权当前设备' : '无法读取当前账号，请检查服务连接并重试')
  const context = await response.json()
  if (!/^[a-f0-9]{64}$/.test(context?.owner) || typeof context?.account !== 'string') throw new Error('设备授权响应无效，请更新服务器后重试')
  if (!isCurrent()) throw new Error('当前连接已改变，请重新打开 Bot 设置')
  return core.authorize({ owner: context.owner, account: context.account, scope, deadline: Date.now() + 120000 }, isCurrent)
}
