import { randomUUID } from 'node:crypto'
import type { McpTool, McpToolResult } from './stdioMcp.js'

export interface PluginClient {
  init(signal?: AbortSignal): Promise<void>
  listTools(signal?: AbortSignal): Promise<McpTool[]>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult>
  dispose(): void
  waitClosed(): Promise<void>
}

/** Streamable HTTP MCP, including JSON and SSE responses. Never follows a
 * redirect with the user's headers, and never advertises client-side execution. */
export class HttpMcp implements PluginClient {
  private controller = new AbortController()
  private session = ''
  private version = '2025-06-18'
  constructor(readonly url: string, readonly headers: Record<string, string> = {}, readonly fetchImpl: typeof fetch = fetch) {}
  async rpc(method: string, params: unknown, signal?: AbortSignal, notification = false): Promise<any> {
    const id = randomUUID()
    const response = await this.fetchImpl(this.url, {
      method: 'POST', redirect: 'error',
      headers: { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.version, ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(method === 'tools/call' ? 120_000 : 15_000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`MCP HTTP ${response.status}`) }
    const session = response.headers.get('mcp-session-id')
    if (session) this.session = session
    if (notification || response.status === 204) { await response.body?.cancel(); return {} }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('MCP 响应为空')
    const decoder = new TextDecoder(); let body = '', bytes = 0
    const sse = response.headers.get('content-type')?.includes('text/event-stream')
    const unpack = (frame: any) => {
      if (frame?.id !== id) return undefined
      if (frame.error) throw new Error('MCP 服务拒绝了请求')
      if (!frame.result || typeof frame.result !== 'object') throw new Error('MCP 响应格式无效')
      return frame.result
    }
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 8 * 1024 * 1024) throw new Error('MCP 响应超过 8 MiB')
        body += decoder.decode(part.value, { stream: true })
        if (sse) {
          body = body.replace(/\r\n/g, '\n')
          let end: number
          while ((end = body.indexOf('\n\n')) >= 0) {
            const event = body.slice(0, end); body = body.slice(end + 2)
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (!data) continue
            const result = unpack(JSON.parse(data))
            if (result !== undefined) return result
          }
        }
      }
      const result = !sse ? unpack(JSON.parse(body + decoder.decode())) : undefined
      if (result === undefined) throw new Error('MCP 未返回对应请求的结果')
      return result
    } finally { await reader.cancel().catch(() => {}) }
  }
  async init(signal?: AbortSignal) {
    const result = await this.rpc('initialize', { protocolVersion: this.version, capabilities: {}, clientInfo: { name: 'yaoyao-bot-plugins', version: '1' } }, signal)
    if (!['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(result.protocolVersion)) throw new Error('MCP 协议版本不支持')
    this.version = result.protocolVersion
    await this.rpc('notifications/initialized', {}, signal, true)
  }
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [], cursors = new Set<string>(); let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, signal)
      if (!Array.isArray(result.tools)) throw new Error('MCP 工具目录无效')
      tools.push(...result.tools)
      if (tools.length > 500) throw new Error('MCP 工具数量超过 500')
      if (!result.nextCursor) return tools
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('MCP 工具分页无效')
      cursor = result.nextCursor; cursors.add(cursor!)
    }
    throw new Error('MCP 工具分页超出限制')
  }
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    const value = await this.rpc('tools/call', { name, arguments: args }, signal)
    if (!Array.isArray(value.content)) throw new Error('MCP 工具返回格式无效')
    return value
  }
  dispose() { this.controller.abort() }
  async waitClosed() {}
}
