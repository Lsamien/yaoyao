import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** Fake Composio plus an actual loopback MCP endpoint and native Hermes bridge.
 * Enabled only by WORKSPACE_FIXTURE_PLUGINS=1 in the disposable browser server. */
export class FixtureBotPlugins {
  private sessions = new Map<string, string>()
  private accounts: any[] = []
  private bindings = new Map<string, any>()
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (!url.hostname.endsWith('composio.dev')) return fetch(input, init)
    const body = JSON.parse(String(init?.body ?? '{}'))
    const send = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url.pathname.endsWith('/tool_router/session')) {
      const id = 'trs_' + randomUUID(); this.sessions.set(id, body.user_id)
      if (!this.accounts.some(a => a.user_id === body.user_id)) this.accounts.push({ id: 'ca_' + randomUUID(), user_id: body.user_id, alias: '隔离测试账号', toolkit: { slug: 'gmail' }, status: 'ACTIVE' })
      return send({ session_id: id, config: { user_id: body.user_id }, mcp: { url: `https://backend.composio.dev/tool_router/${id}/mcp` } })
    }
    if (url.pathname.endsWith('/toolkits')) return send({ items: [{ slug: 'gmail', name: 'Gmail', description: '读取邮件与管理草稿' }, { slug: 'github', name: 'GitHub', description: '代码仓库与议题' }, { slug: 'notion', name: 'Notion', description: '文档与知识库' }] })
    if (url.pathname.endsWith('/connected_accounts')) return send({ items: this.accounts.filter(a => a.user_id === url.searchParams.get('user_ids')) })
    if (url.pathname.includes('/connected_accounts/') && init?.method === 'DELETE') { this.accounts = this.accounts.filter(a => a.id !== url.pathname.split('/').at(-1)); return send({ ok: true }) }
    if (url.pathname.endsWith('/link')) return send({ redirect_url: 'https://connect.composio.dev/fixture-not-a-real-oauth-link' })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return send(this.mcp(body))
  }
  private mcp(frame: any) {
    const result = frame.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'isolated-plugin-fixture', version: '1' } }
      : frame.method === 'tools/list' ? { tools: [{ name: 'fixture_echo', description: '回传验收文字，不访问外部服务', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }
        : { content: [{ type: 'text', text: String(frame.params?.arguments?.value ?? '') }], structuredContent: { verified: true } }
    return { jsonrpc: '2.0', id: frame.id, result }
  }
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (pathname !== '/__fixture/mcp' && !pathname.startsWith('/api/plugins/yaoyao-bot-bridge/')) return false
    if (pathname.endsWith('/capabilities')) { res.end(JSON.stringify({ version: 1, ready: true, native_tools: true, in_process: true })); return true }
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const frame = JSON.parse(raw || '{}')
      if (pathname.endsWith('/bind')) this.bindings.set(frame.session_id, frame)
      if (pathname.endsWith('/unbind')) this.bindings.delete(frame.session_id)
      if (pathname === '/__fixture/mcp') {
        if (!frame.id) { res.statusCode = 202; res.end(); return }
        res.end(JSON.stringify(this.mcp(frame))); return
      }
      res.end(JSON.stringify({ ok: true, native_tools: true }))
    })
    return true
  }
  async exercise(sessionId: string) {
    const binding = this.bindings.get(sessionId)
    if (!binding) throw new Error('本轮没有原生插件绑定')
    const call = async (path: string, body: unknown) => {
      const response = await fetch(binding.bridge_url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + binding.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error('插件桥拒绝了测试请求')
      return response.json() as Promise<any>
    }
    const catalog = await call('/tools/list', {})
    const tool = catalog.tools.find((t: any) => t.description.includes('fixture_echo'))
    if (!tool) throw new Error('本轮没有已授权的插件工具')
    const result = await call('/tools/call', { toolId: tool.id, arguments: { value: 'Bot 插件原生调用成功' }, callId: randomUUID() })
    return { tool, result }
  }
}
