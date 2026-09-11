import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import WebSocket, { WebSocketServer } from 'ws'

const port = Number(process.env.FAKE_HERMES_PORT || 19119)
const localAuthorization = process.env.FAKE_HERMES_LOCAL_AUTH === '1'
const localToken = 'fixture_native_loopback_session_token_123456'
const epoch = '11111111-1111-4111-8111-111111111111'
const roomId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const secondAgentId = '34343434-3434-4434-8434-343434343434'
const topicId = '77777777-7777-4777-8777-777777777777'
const releaseTopicId = '88888888-8888-4888-8888-888888888888'
const now = () => Date.now() / 1000
let groupCursor = 0
const groupClients = new Set()
let groupConnectionCount = 0
let groupAvailable = true

const kanbanColumns = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done']
const kanbanBoards = [
  { slug: 'default', name: '产品研发', description: 'Web 与移动端功能', is_current: true, default_workspace_kind: 'scratch' },
  { slug: 'mobile-release', name: '移动端发布', description: 'iOS 与 Android 发布任务', is_current: false, default_workspace_kind: 'worktree' },
]
let kanbanTaskSequence = 3
let kanbanEventSequence = 3
const kanbanTasks = [
  { id: 't_web001', board: 'default', title: '完成 Web 看板验收', body: '覆盖桌面与 390px 响应式布局', status: 'running', assignee: 'yaoyao', tenant: 'web', priority: 3, created_by: 'dashboard', created_at: now() - 1800, started_at: now() - 420, latest_summary: '正在执行浏览器验收', comment_count: 1, link_counts: { parents: 0, children: 1 }, progress: { done: 0, total: 1 } },
  { id: 't_ios001', board: 'default', title: '核对 iOS 双端口', body: '9119 与 15300 使用同一契约', status: 'ready', assignee: 'yaoer', tenant: 'mobile', priority: 2, created_by: 'dashboard', created_at: now() - 1200, comment_count: 0, link_counts: { parents: 1, children: 0 }, progress: null },
  { id: 't_done01', board: 'mobile-release', title: '准备发布说明', body: '整理已完成事项', status: 'done', assignee: 'yaoyao', tenant: 'release', priority: 1, created_by: 'dashboard', created_at: now() - 7200, completed_at: now() - 3600, latest_summary: '发布说明已完成', comment_count: 0, link_counts: { parents: 0, children: 0 }, progress: null },
]
const kanbanComments = new Map([
  ['t_web001', [{ id: 1, task_id: 't_web001', author: 'admin', body: '请保留真实浏览器验收证据。', created_at: now() - 600 }]],
])
const kanbanEvents = new Map([
  ['t_web001', [
    { id: 1, task_id: 't_web001', run_id: null, kind: 'created', payload: { status: 'ready', assignee: 'yaoyao' }, created_at: now() - 1800 },
    { id: 2, task_id: 't_web001', run_id: 1, kind: 'claimed', payload: { profile: 'yaoyao' }, created_at: now() - 420 },
  ]],
  ['t_ios001', [{ id: 3, task_id: 't_ios001', run_id: null, kind: 'created', payload: { status: 'ready', assignee: 'yaoer' }, created_at: now() - 1200 }]],
])
const kanbanRuns = new Map([
  ['t_web001', [{ id: 1, task_id: 't_web001', profile: 'yaoyao', status: 'running', outcome: null, summary: '正在执行浏览器验收', metadata: { verification: ['playwright'] }, worker_pid: 12345, started_at: now() - 420, ended_at: null }]],
])

function kanbanBoardSlug(url) {
  return url.searchParams.get('board') || 'default'
}

function kanbanBoardSnapshot(url) {
  const slug = kanbanBoardSlug(url)
  const includeArchived = url.searchParams.get('include_archived') === 'true'
  const scoped = kanbanTasks.filter(task => task.board === slug && (includeArchived || task.status !== 'archived'))
  const columns = [...kanbanColumns, ...(includeArchived ? ['archived'] : [])]
    .map(name => ({ name, tasks: scoped.filter(task => task.status === name) }))
  return {
    columns,
    tenants: [...new Set(scoped.map(task => task.tenant).filter(Boolean))].sort(),
    assignees: [...new Set(scoped.map(task => task.assignee).filter(Boolean))].sort(),
    latest_event_id: kanbanEventSequence,
    now: now(),
  }
}

function recordKanbanEvent(task, kind, payload = null, runId = null) {
  const event = { id: ++kanbanEventSequence, task_id: task.id, run_id: runId, kind, payload, created_at: now() }
  kanbanEvents.set(task.id, [...(kanbanEvents.get(task.id) || []), event])
  return event
}

function broadcastGroup(event, payload) {
  groupCursor += 1
  const frame = JSON.stringify({ type: 'group.event', epoch, cursor: groupCursor, roomId, event, payload })
  for (const client of groupClients) if (client.readyState === WebSocket.OPEN) client.send(frame)
}

function authenticated(request) {
  if (localAuthorization) return request.headers['x-hermes-session-token'] === localToken
  return String(request.headers.cookie || '').includes('fake_session=authenticated')
}

function json(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    ...headers,
  })
  response.end(body)
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const profiles = [
  { name: 'yaoyao', description: '夭夭', is_default: true, model: 'gpt-5.6', provider: 'openai', gateway_running: true },
  { name: 'yaoer', description: '瑶儿', is_default: false, model: 'gpt-5.6', provider: 'openai', gateway_running: true },
]
// This intentionally differs from local timestamp/pin ranking. Browser tests
// verify that the WebUI preserves the ordering returned by 9119.
const sessions = [
  // `source` is mutable display metadata, not ownership proof. This row is
  // intentionally absent from the Web user's registry and must stay history-only.
  { id: 'session-history-only', profile: 'yaoyao', source: 'web', title: 'Hermes 外部历史', preview: '只读历史记录', message_count: 1, tool_call_count: 0, started_at: now() - 1800, last_active_at: now() - 900, model: 'gpt-5.6', provider: 'openai' },
  { id: 'session-second', profile: 'yaoyao', source: 'web', title: '第二个会话', preview: '用于验证列表和切换', message_count: 2, tool_call_count: 0, started_at: now() - 7200, last_active_at: now() - 600, model: 'gpt-5.5', provider: 'openai' },
  { id: 'session-demo', profile: 'yaoyao', source: 'web', title: '夭夭 AI 验收会话', preview: '文件库与群聊已经就绪', message_count: 4, tool_call_count: 1, started_at: now() - 3600, last_active_at: now(), pinned: true, model: 'gpt-5.6', provider: 'openai' },
  { id: 'session-yaoer', profile: 'yaoer', source: 'web', title: '瑶儿专属会话', message_count: 1, tool_call_count: 0, started_at: now() - 3500, last_active_at: now() - 20, model: 'gpt-5.6', provider: 'openai' },
  { id: 'session-media', profile: 'yaoer', source: 'web', title: '瑶儿生成图片验收', message_count: 1, tool_call_count: 0, started_at: now() - 3400, last_active_at: now() - 30, model: 'gpt-5.6', provider: 'openai' },
  { id: 'session-user-media', profile: 'yaoer', source: 'web', title: '用户多图验收', message_count: 1, tool_call_count: 0, started_at: now() - 3300, last_active_at: now() - 40, model: 'gpt-5.6', provider: 'openai' },
  ...Array.from({ length: 101 }, (_, index) => ({ id: `session-page-${index + 1}`, profile: 'yaoyao', source: 'web', title: `分页会话 ${index + 1}`, message_count: 0, tool_call_count: 0, started_at: now() - 10_000 - index, last_active_at: now() - 10_000 - index })),
]
const messages = [
  { id: 'message-user', role: 'user', content: '请检查今天生成的产物。MEDIA:/brand/AppIcon-1024.png', timestamp: now() - 180 },
  { id: 'message-user-file', role: 'user', content: '查看附件\n\n[用户附加文件：测试报告.docx]\n@file:`attachments/测试报告.docx`', timestamp: now() - 179 },
  { id: 'message-user-image', role: 'user', content: '[用户附加图片：测试图片.png]\n@image:/Users/samien/.hermes/images/upload_test.png\n[screenshot]', timestamp: now() - 178 },
  { id: 'message-thinking-tool', role: 'assistant', content: '', reasoning_content: '先检索文件，再归纳结果。', tool_calls: [{ id: 'tool-thinking', type: 'function', function: { name: 'file_search', arguments: '{"query":"产物"}' } }], timestamp: now() - 177 },
  { id: 'message-tool-call', role: 'assistant', content: '', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'file_search', arguments: '{"query":"产物"}' } }], timestamp: now() - 176 },
  { id: 'message-tool', role: 'tool', tool_name: 'file_search', tool_call_id: 'tool-1', summary: '扫描产物目录', result: { path: '/tmp/demo-report.pdf', count: 1 }, timestamp: now() - 175 },
  { id: 'message-assistant', role: 'assistant', content: '已整理完成。下面是 **验收摘要**：\n\n## 验收摘要\n\n- 普通聊天已连接\n- 群聊 v4 已就绪\n- [打开报告](https://example.com/report)', reasoning_content: '先核对会话与文件索引。', timestamp: now() - 170 },
  { id: 'message-image', role: 'assistant', content: '预览图：![夭夭 Logo](/brand/AppIcon-1024.png)', timestamp: now() - 160 },
  { id: 'message-image-second', role: 'assistant', content: '第二张：![夭夭 Logo 2](/brand/AppIcon-1024.png?variant=2)', timestamp: now() - 155 },
  { id: 'message-legacy-media', role: 'assistant', content: '历史兼容：MEDIA:/brand/AppIcon-1024.png', timestamp: now() - 150 },
  { id: 'message-local-link', role: 'assistant', content: '[方案草稿.md](/Users/samien/Agents/方案草稿.md)', timestamp: now() - 145 },
  { id: 'message-compaction', role: 'user', content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n\n## Historical Task Snapshot\n\n- 已完成普通聊天验收\n- 保留当前会话上下文', timestamp: now() - 143 },
  { id: 'message-delegation', role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE]\n后台子任务已经完成。', display_kind: 'async_delegation_complete', display_metadata: { task_count: 2, completed_count: 2, failed_count: 0, duration_seconds: 71 }, timestamp: now() - 140 },
  { id: 'message-background-process', role: 'user', content: '[IMPORTANT: Background process proc_6be40e6c3864 exited (exit code 143, SIGTERM).\nCommand: ./run_mac.sh\nOutput:\nmodel loaded', timestamp: now() - 135 },
  { id: 'message-system', role: 'user', content: '[System: The active model for this chat has changed to gpt-5.6-terra via provider openai.]', timestamp: now() - 130 },
]
// These are Hermes-owned paths, deliberately absent from the Web server's
// filesystem. Only the authenticated upstream file API can serve their bytes.
const profileMediaPaths = [
  '/Users/samien/.hermes/profiles/yaoer/cache/images/openai_codex_gpt-image-2-high_20260902_194820_1d225f08.png',
  '/Users/samien/.hermes/profiles/yaoer/cache/images/国漫三视图.png',
]
const userProfileMediaPaths = Array.from({ length: 9 }, (_, index) =>
  `/Users/samien/.hermes/profiles/yaoer/images/upload_20260815_233834_${index + 1}.png`)
const userProfileMediaMessages = [{
  id: 'message-user-profile-media', role: 'user', timestamp: now() - 40,
  content: [
    '读取图片中的提示词',
    ...userProfileMediaPaths.map((_, index) => `[用户附加图片：照片-${index + 1}.png]`),
    ...userProfileMediaPaths.map(path => `@image:${path}`),
    ...userProfileMediaPaths.map(() => '[screenshot]'),
  ].join('\n'),
}]
const profileMediaPng = readFileSync(new URL('../../public/brand/AppIcon-1024.png', import.meta.url))
const profileMediaMessages = [{
  id: 'message-profile-media', role: 'assistant', timestamp: now() - 30,
  content: `已经生成两张图片：\n\n![3D 半写实女性四视图](${profileMediaPaths[0]})\n\n![国漫三视图](${profileMediaPaths[1]})`,
}]
const groupAgent = { id: agentId, roomId, profile: 'yaoyao', displayName: '夭夭', description: '主 Agent', enabled: true, replyWithoutMention: true, isHost: true, model: 'gpt-5.6', provider: 'openai', reasoningEffort: 'high', fastMode: true, status: 'idle', createdAt: now() - 2000, updatedAt: now() }
const secondGroupAgent = { id: secondAgentId, roomId, profile: 'yaoer', nodeId: 'remote-node', nodeLabel: '远程节点', displayName: '瑶儿', description: '评审 Agent', enabled: true, replyWithoutMention: false, isHost: false, model: 'gpt-5.6', provider: 'openai', reasoningEffort: 'medium', fastMode: false, status: 'idle', createdAt: now() - 1900, updatedAt: now() }
const groupAgents = [groupAgent, secondGroupAgent]
const groupMessage = { seq: 1, id: '44444444-4444-4444-8444-444444444444', roomId, topicId, senderKind: 'human', senderId: 'demo-user', senderName: '验收用户', content: '大家好，检查一下群聊输入框。', status: 'completed', createdAt: now() - 120, updatedAt: now() - 120 }
const groupAssistantMessage = { seq: 2, id: '55555555-5555-4555-8555-555555555555', roomId, topicId, senderKind: 'agent', senderId: agentId, senderName: '夭夭', content: '历史兼容：MEDIA:/brand/AppIcon-1024.png', status: 'completed', createdAt: now() - 100, updatedAt: now() - 100 }
const releaseTopicMessage = { seq: 3, id: '99999999-9999-4999-8999-999999999999', roomId, topicId: releaseTopicId, senderKind: 'human', senderId: 'demo-user', senderName: '验收用户', content: '请核对发布话题的独立历史。', status: 'completed', createdAt: now() - 500, updatedAt: now() - 500 }
const groupMessages = [groupMessage, groupAssistantMessage, releaseTopicMessage]
const groupTopics = [
  { id: topicId, roomId, title: '设计验收', preview: groupAssistantMessage.content, messageCount: 2, unreadCount: 1, latestMessageSeq: 2, createdAt: now() - 120, updatedAt: now() - 100 },
  { id: releaseTopicId, roomId, title: '发布检查', preview: releaseTopicMessage.content, messageCount: 1, unreadCount: 0, latestMessageSeq: 3, createdAt: now() - 500, updatedAt: now() - 500 },
]
let nextGroupSeq = 4
const avatarMembers = groupAgents.map(agent => ({ profile: agent.profile, nodeId: 'local', displayName: agent.displayName }))
const room = { id: roomId, name: '设计与工程协作', avatar: '', avatarMembers, cwd: '/tmp', createdAt: now() - 2000, updatedAt: now(), archived: false, agentCount: groupAgents.length, maxReplyRounds: -1, lastMessage: groupAssistantMessage, unreadCount: 1, activeRunCount: 0 }
const rpcRequests = []
const previewPdf = Buffer.from('JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTAgMDAwMDAgbiAKMDAwMDAwMDA1MyAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA0L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMTY2CiUlRU9G', 'base64')

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  if (url.pathname === '/__test/group-connections' && request.method === 'GET') return json(response, 200, { count: groupConnectionCount })
  if (url.pathname === '/__test/groups/availability' && request.method === 'POST') {
    groupAvailable = (await body(request)).available !== false
    return json(response, 200, { available: groupAvailable })
  }
  if (url.pathname === '/__test/groups/disconnect' && request.method === 'POST') {
    for (const client of groupClients) client.terminate()
    return json(response, 200, { ok: true })
  }
  if (url.pathname === '/__test/rpc-requests' && request.method === 'GET') return json(response, 200, { requests: rpcRequests })
  if (url.pathname === '/__test/rpc-requests/reset' && request.method === 'POST') {
    rpcRequests.length = 0
    return json(response, 200, { ok: true })
  }
  if (localAuthorization && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    return response.end(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(localToken)};</script>`)
  }
  if (url.pathname === '/api/status') return json(response, 200, { version: 'test', overall: 'ok', auth_required: !localAuthorization, auth_providers: localAuthorization ? [] : ['basic'], gateway_running: true, gateway_state: 'running' })
  if (localAuthorization && ['/api/auth/providers', '/api/auth/ws-ticket', '/auth/password-login'].includes(url.pathname)) return json(response, 403, { detail: 'No account or ticket in local mode' })
  if (url.pathname === '/api/auth/providers') return json(response, 200, { providers: [{ name: 'basic', display_name: '账号密码', supports_password: true }] })
  if (url.pathname === '/auth/password-login' && request.method === 'POST') {
    const input = await body(request)
    if (input.username !== 'test' || input.password !== 'test') return json(response, 401, { detail: 'Invalid credentials' })
    return json(response, 200, { ok: true, next: '' }, { 'Set-Cookie': 'fake_session=authenticated; Path=/; HttpOnly; SameSite=Lax' })
  }
  if (url.pathname === '/auth/logout' && request.method === 'POST') return json(response, 200, { ok: true }, { 'Set-Cookie': 'fake_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' })
  if (!authenticated(request)) return json(response, 401, { detail: 'Unauthorized' })
  if (url.pathname === '/api/config') return json(response, 200, { terminal: { cwd: '/tmp/hermes-fixture' } })
  if (url.pathname === '/api/fs/default-cwd') return json(response, 200, { cwd: '/tmp/hermes-fixture' })
  if (url.pathname === '/api/files') {
    const path = url.searchParams.get('path') || '/tmp/hermes-fixture'
    return json(response, 200, { path, entries: [...profileMediaPaths, ...userProfileMediaPaths, '/tmp/hello.png']
      .filter(file => file.slice(0, file.lastIndexOf('/')) === path)
      .map(file => ({ name: file.split('/').at(-1), path: file, is_directory: false })) })
  }
  if (url.pathname === '/api/files/download' && request.method === 'GET') {
    const path = url.searchParams.get('path')
    if (![...profileMediaPaths, ...userProfileMediaPaths, '/tmp/hello.png'].includes(path)) return json(response, 404, { detail: 'File not found' })
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': profileMediaPng.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1))}`,
    })
    return response.end(profileMediaPng)
  }
  if (url.pathname.startsWith('/api/plugins/yaoyao/v1/') && !groupAvailable) return json(response, 503, { detail: 'Group service temporarily unavailable' })
  if (url.pathname === '/api/auth/me') return json(response, 200, { user_id: 'demo-user', display_name: '验收用户', email: 'demo@example.invalid', provider: 'basic' })
  if (url.pathname === '/api/auth/ws-ticket' && request.method === 'POST') return json(response, 200, { ticket: 'fake-ticket' })
  if (url.pathname === '/api/profiles') return json(response, 200, { profiles })
  if (url.pathname === '/api/dashboard/plugins') return json(response, 200, [{ name: 'yaoyao', version: '1.7.3' }, { name: 'kanban', version: '1.0.0' }])
  if (url.pathname === '/api/plugins/yaoyao/profiles') return json(response, 200, { profiles: [
    { name: 'yaoyao', label: '夭夭', botName: '夭夭', agentName: '旧夭夭名称', isDefault: true },
    { name: 'yaoer', label: '瑶儿', botName: '瑶儿', agentName: '旧瑶儿名称', isDefault: false },
  ] })
  if (url.pathname === '/api/plugins/kanban/boards' && request.method === 'GET') {
    return json(response, 200, {
      boards: kanbanBoards.map(board => {
        const scoped = kanbanTasks.filter(task => task.board === board.slug)
        const counts = Object.fromEntries(kanbanColumns.map(status => [status, scoped.filter(task => task.status === status).length]))
        return { ...board, counts, total: scoped.filter(task => task.status !== 'archived').length }
      }),
      current: 'default',
    })
  }
  if (url.pathname === '/api/plugins/kanban/boards' && request.method === 'POST') {
    const input = await body(request)
    const slug = String(input.slug || '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) return json(response, 400, { detail: 'invalid board slug' })
    let board = kanbanBoards.find(item => item.slug === slug)
    if (!board) {
      board = { slug, name: String(input.name || slug), description: String(input.description || ''), is_current: false, default_workspace_kind: 'scratch' }
      kanbanBoards.push(board)
    }
    return json(response, 200, { board, current: 'default' })
  }
  if (url.pathname === '/api/plugins/kanban/board' && request.method === 'GET') {
    return json(response, 200, kanbanBoardSnapshot(url))
  }
  if (url.pathname === '/api/plugins/kanban/profiles' && request.method === 'GET') {
    return json(response, 200, { profiles: profiles.map(profile => ({
      name: profile.name,
      is_default: profile.is_default,
      description: profile.description,
      description_auto: false,
      model: profile.model,
      provider: profile.provider,
    })) })
  }
  if (url.pathname === '/api/plugins/kanban/tasks' && request.method === 'POST') {
    const input = await body(request)
    if (!String(input.title || '').trim()) return json(response, 400, { detail: 'title is required' })
    const task = {
      id: `t_e2e${kanbanTaskSequence++}`,
      board: kanbanBoardSlug(url),
      title: String(input.title).trim(),
      body: input.body == null ? null : String(input.body),
      status: input.triage === true ? 'triage' : 'ready',
      assignee: input.assignee == null ? null : String(input.assignee),
      tenant: input.tenant == null ? null : String(input.tenant),
      priority: Number(input.priority) || 0,
      created_by: 'dashboard',
      created_at: now(),
      comment_count: 0,
      link_counts: { parents: Array.isArray(input.parents) ? input.parents.length : 0, children: 0 },
      progress: null,
    }
    kanbanTasks.push(task)
    recordKanbanEvent(task, 'created', { status: task.status, assignee: task.assignee })
    return json(response, 200, { task })
  }
  const kanbanCommentMatch = /^\/api\/plugins\/kanban\/tasks\/([^/]+)\/comments$/.exec(url.pathname)
  if (kanbanCommentMatch && request.method === 'POST') {
    const id = decodeURIComponent(kanbanCommentMatch[1])
    const task = kanbanTasks.find(item => item.id === id && item.board === kanbanBoardSlug(url))
    if (!task) return json(response, 404, { detail: 'task not found' })
    const input = await body(request)
    if (!String(input.body || '').trim()) return json(response, 400, { detail: 'body is required' })
    const comments = kanbanComments.get(id) || []
    comments.push({ id: comments.length + 1, task_id: id, author: String(input.author || 'dashboard'), body: String(input.body).trim(), created_at: now() })
    kanbanComments.set(id, comments)
    task.comment_count = comments.length
    recordKanbanEvent(task, 'commented', { author: input.author || 'dashboard' })
    return json(response, 200, { ok: true })
  }
  const kanbanTaskMatch = /^\/api\/plugins\/kanban\/tasks\/([^/]+)$/.exec(url.pathname)
  if (kanbanTaskMatch) {
    const id = decodeURIComponent(kanbanTaskMatch[1])
    const index = kanbanTasks.findIndex(item => item.id === id && item.board === kanbanBoardSlug(url))
    const task = kanbanTasks[index]
    if (!task) return json(response, 404, { detail: 'task not found' })
    if (request.method === 'PATCH') {
      const input = await body(request)
      const previousStatus = task.status
      for (const key of ['title', 'body', 'assignee', 'priority', 'result']) {
        if (Object.prototype.hasOwnProperty.call(input, key)) task[key] = input[key]
      }
      if (typeof input.status === 'string' && input.status) task.status = input.status
      if (task.status !== previousStatus) recordKanbanEvent(task, 'status', { status: task.status })
      else recordKanbanEvent(task, 'edited', null)
      return json(response, 200, { task })
    }
    if (request.method === 'DELETE') {
      kanbanTasks.splice(index, 1)
      kanbanComments.delete(id)
      kanbanEvents.delete(id)
      kanbanRuns.delete(id)
      return json(response, 200, { ok: true })
    }
    if (request.method === 'GET') {
      return json(response, 200, {
        task,
        comments: kanbanComments.get(id) || [],
        events: kanbanEvents.get(id) || [],
        attachments: [],
        links: { parents: id === 't_ios001' ? ['t_web001'] : [], children: id === 't_web001' ? ['t_ios001'] : [] },
        child_results: id === 't_web001' ? [{ id: 't_ios001', title: '核对 iOS 双端口', status: 'ready' }] : [],
        runs: kanbanRuns.get(id) || [],
      })
    }
  }
  if (url.pathname === '/api/plugins/kanban/dispatch' && request.method === 'POST') {
    const task = kanbanTasks.find(item => item.board === kanbanBoardSlug(url) && item.status === 'ready' && item.assignee)
    if (!task) return json(response, 200, { spawned: [] })
    task.status = 'running'
    task.started_at = now()
    const run = { id: kanbanRuns.size + 2, task_id: task.id, profile: task.assignee, status: 'running', outcome: null, summary: null, metadata: null, worker_pid: 12346, started_at: task.started_at, ended_at: null }
    kanbanRuns.set(task.id, [...(kanbanRuns.get(task.id) || []), run])
    recordKanbanEvent(task, 'claimed', { profile: task.assignee }, run.id)
    return json(response, 200, { spawned: [{ task_id: task.id, profile: task.assignee }] })
  }
  if (url.pathname === '/api/model/options') return json(response, 200, { model: 'gpt-5.6', provider: 'openai', providers: [{ slug: 'openai', name: 'OpenAI', models: ['gpt-5.6', 'gpt-5.5'] }] })
  if (url.pathname === '/api/profiles/sessions' || url.pathname === '/api/sessions') {
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
    const limit = Math.max(1, Number(url.searchParams.get('limit') || 100))
    const excluded = new Set((url.searchParams.get('exclude_sources') || '').split(',').filter(Boolean))
    const scoped = sessions.filter(item => (!url.searchParams.get('profile') || item.profile === url.searchParams.get('profile'))
      && (!url.searchParams.get('source') || item.source === url.searchParams.get('source')) && !excluded.has(item.source))
    return json(response, 200, { sessions: scoped.slice(offset, offset + limit), total: scoped.length, offset, limit })
  }
  if (/^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3])
    const scopedMessages = id === 'session-media' ? profileMediaMessages
      : id === 'session-user-media' ? userProfileMediaMessages
      : id === 'session-yaoer' ? [{ id: 'yaoer-history', role: 'assistant', content: '瑶儿历史消息', timestamp: now() - 10 }] : messages
    return json(response, 200, { messages: scopedMessages, pagination: { total: scopedMessages.length, returned: scopedMessages.length, limit: 150, hasMore: false } })
  }
  if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').at(-1))
    const session = sessions.find(item => item.id === id && (!url.searchParams.get('profile') || item.profile === url.searchParams.get('profile')))
    if (session && request.method === 'PATCH') {
      const input = await body(request)
      if (typeof input.pinned === 'boolean') session.pinned = input.pinned
      if (typeof input.title === 'string' && input.title.trim()) session.title = input.title.trim()
      return json(response, 200, { ok: true, pinned: session.pinned, title: session.title })
    }
    return session ? json(response, 200, session) : json(response, 404, { detail: 'Not found' })
  }
  if (url.pathname === '/api/session-unread') return json(response, 200, { items: { 'session-demo': 0 } })
  if (url.pathname === '/api/plugins/yaoyao/v1/capabilities') return json(response, 200, { protocolVersion: 12, journalEpoch: epoch, latestCursor: groupCursor, limits: { maxAgentsPerRoom: 8, maxMessageBytes: 65536, maxMessagePageSize: 100, defaultMaxReplyRounds: 3, unlimitedReplyRoundsValue: -1, maxAgentDisplayNameLength: 100, maxRoomAvatarLength: 524288 }, features: ['roomAvatar'], eventTypes: ['message.upsert', 'topic.updated', 'room.activity', 'run.updated', 'agent.status', 'agent.updated'] })
  if (url.pathname === '/api/plugins/yaoyao/v1/topics/pinned') return json(response, 200, { items: groupTopics.filter(topic => topic.pinned), nextCursor: null })
  if (url.pathname === '/api/plugins/yaoyao/v1/rooms') return json(response, 200, { items: [room], nextCursor: null })
  if (url.pathname === `/api/plugins/yaoyao/v1/rooms/${roomId}`) {
    if (request.method === 'PATCH') {
      const input = await body(request)
      for (const key of ['name', 'cwd', 'instructions', 'avatar', 'maxReplyRounds', 'orchestrationMode']) {
        if (Object.prototype.hasOwnProperty.call(input, key)) room[key] = input[key]
      }
      room.updatedAt = now()
    }
    return json(response, 200, { ...room, agents: groupAgents, runs: [], pendingInteractions: [], latestCursor: groupCursor })
  }
  const agentPatchMatch = new RegExp(`^/api/plugins/yaoyao/v1/rooms/${roomId}/agents/([^/]+)$`).exec(url.pathname)
  if (agentPatchMatch && request.method === 'PATCH') {
    const target = groupAgents.find(agent => agent.id === decodeURIComponent(agentPatchMatch[1]))
    if (!target) return json(response, 404, { detail: 'Agent not found' })
    const input = await body(request)
    if (input.displayName === '所有人') return json(response, 409, { detail: '成员名称不能使用“所有人”' })
    const changed = []
    if (input.isHost === true) {
      for (const agent of groupAgents) {
        if (agent.id !== target.id && agent.isHost) {
          agent.isHost = false
          agent.updatedAt = now()
          changed.push(agent)
        }
      }
    }
    for (const key of ['displayName', 'description', 'enabled', 'replyWithoutMention', 'isHost', 'model', 'provider', 'reasoningEffort', 'fastMode']) {
      if (Object.prototype.hasOwnProperty.call(input, key)) target[key] = input[key]
    }
    target.updatedAt = now()
    changed.push(target)
    json(response, 200, target)
    setTimeout(() => {
      for (const agent of changed) broadcastGroup('agent.updated', agent)
    }, 10)
    return
  }
  if (url.pathname === `/api/plugins/yaoyao/v1/rooms/${roomId}/topics`) {
    return json(response, 200, { items: [...groupTopics].sort((a, b) => b.updatedAt - a.updatedAt), nextCursor: null })
  }
  const topicReadMatch = new RegExp(`^/api/plugins/yaoyao/v1/rooms/${roomId}/topics/([^/]+)/read$`).exec(url.pathname)
  if (topicReadMatch && request.method === 'PATCH') {
    const topic = groupTopics.find(item => item.id === decodeURIComponent(topicReadMatch[1]))
    if (!topic) return json(response, 404, { detail: 'Topic not found' })
    const input = await body(request)
    topic.unreadCount = 0
    topic.latestMessageSeq = Math.max(topic.latestMessageSeq, Number(input.throughSeq) || 0)
    room.unreadCount = groupTopics.reduce((count, item) => count + item.unreadCount, 0)
    return json(response, 200, { topic, room: { roomId, activeRunCount: room.activeRunCount, unreadCount: room.unreadCount, lastMessage: room.lastMessage } })
  }
  if (url.pathname === `/api/plugins/yaoyao/v1/rooms/${roomId}/messages` && request.method === 'POST') {
    const input = await body(request)
    if (typeof input.topicId !== 'string' || !input.topicId) return json(response, 400, { detail: 'topicId is required for group protocol v4' })
    const sentAt = now()
    const sent = { ...groupMessage, seq: nextGroupSeq++, id: input.clientMessageId, topicId: input.topicId, clientMessageId: input.clientMessageId, content: input.content, createdAt: sentAt, updatedAt: sentAt }
    groupMessages.push(sent)
    let topic = groupTopics.find(item => item.id === input.topicId)
    if (topic) {
      topic.preview = sent.content
      topic.messageCount = groupMessages.filter(message => message.topicId === input.topicId).length
      topic.latestMessageSeq = sent.seq
      topic.updatedAt = sentAt
    } else {
      topic = { id: input.topicId, roomId, title: String(input.content || '').trim().split('\n')[0].slice(0, 40) || '新话题', preview: sent.content, messageCount: 1, unreadCount: 0, latestMessageSeq: sent.seq, createdAt: sentAt, updatedAt: sentAt }
      groupTopics.push(topic)
    }
    room.lastMessage = sent
    room.updatedAt = sentAt
    const runId = '66666666-6666-4666-8666-666666666666'
    const run = { id: runId, roomId, topicId: input.topicId, agentId, triggerMessageId: sent.id, responseMessageId: '', rootMessageId: sent.id, depth: 0, status: 'queued', runtimeSessionId: null, error: '', replyMode: 'automatic', createdAt: sentAt, updatedAt: sentAt }
    json(response, 200, { message: sent, runs: [run] })
    setTimeout(() => broadcastGroup('message.upsert', sent), 20)
    setTimeout(() => broadcastGroup('topic.updated', topic), 30)
    setTimeout(() => broadcastGroup('run.updated', { ...run, status: 'queued', updatedAt: now() }), 40)
    setTimeout(() => broadcastGroup('agent.status', { roomId, agentId, status: 'queued', runId }), 40)
    setTimeout(() => broadcastGroup('run.updated', { ...run, status: 'running', runtimeSessionId: 'group-runtime-demo', updatedAt: now() }), 650)
    setTimeout(() => broadcastGroup('agent.status', { roomId, agentId, status: 'running', runId }), 650)
    setTimeout(() => broadcastGroup('run.updated', { ...run, status: 'completed', runtimeSessionId: 'group-runtime-demo', updatedAt: now() }), 1800)
    setTimeout(() => broadcastGroup('agent.status', { roomId, agentId, status: 'idle', runId: null }), 1800)
    setTimeout(() => broadcastGroup('room.activity', { roomId, activeRunCount: 0, unreadCount: room.unreadCount, lastMessage: room.lastMessage }), 1810)
    return
  }
  if (url.pathname === `/api/plugins/yaoyao/v1/rooms/${roomId}/messages`) {
    const selectedTopicId = url.searchParams.get('topicId')
    const items = selectedTopicId ? groupMessages.filter(message => message.topicId === selectedTopicId) : groupMessages
    return json(response, 200, { items })
  }
  if (url.pathname === '/api/plugins/yaoyao/files') return json(response, 200, { items: [{ id: 1, path: '/tmp/demo-report.pdf', name: 'demo-report.pdf', extension: 'pdf', mimeType: 'application/pdf', size: 204800, modifiedAt: now(), exists: true, origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 AI 验收会话', messageId: 'message-assistant', authorKind: 'assistant', authorName: '夭夭', observedAt: now() }] }], nextCursor: null, total: 1 })
  if (url.pathname === '/api/plugins/yaoyao/1/download') {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': previewPdf.length })
    return response.end(previewPdf)
  }
  json(response, 404, { detail: `No fake route for ${request.method} ${url.pathname}` })
})

const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  if (localAuthorization ? url.searchParams.get('token') !== localToken || url.searchParams.has('ticket')
    : url.searchParams.get('ticket') !== 'fake-ticket') return socket.destroy()
  sockets.handleUpgrade(request, socket, head, client => {
    if (url.pathname.endsWith('/events')) {
      groupConnectionCount += 1
      groupClients.add(client)
      client.once('close', () => groupClients.delete(client))
      client.send(JSON.stringify({ type: 'group.ready', epoch, cursor: groupCursor, heartbeatSeconds: 20 }))
      return
    }
    client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { capabilities: ['safe_interrupt', 'session_reasoning_config'] } } }))
    client.on('message', raw => {
      const requestFrame = JSON.parse(raw.toString())
      rpcRequests.push(requestFrame)
      const respond = result => client.send(JSON.stringify({ jsonrpc: '2.0', id: requestFrame.id, result }))
      if (requestFrame.method === 'session.cwd.set') return respond({ cwd: requestFrame.params.cwd })
      if (requestFrame.method === 'session.resume') return respond({ session_id: 'runtime-demo', stored_session_id: requestFrame.params.session_id, fast: requestFrame.params.session_id === 'session-yaoer', messages: [] })
      if (requestFrame.method === 'session.create') return respond({ session_id: 'runtime-new', stored_session_id: 'session-new', fast: requestFrame.params.fast === true })
      if (requestFrame.method === 'session.usage') return respond({ context_used: 12500, context_max: 114688, total: 12500, input: 9000, output: 3500 })
      if (requestFrame.method === 'prompt.submit') {
        respond({ status: 'accepted' })
        setTimeout(() => {
          const emit = (type, payload) => client.send(JSON.stringify({
            jsonrpc: '2.0', method: 'event',
            params: { type, session_id: requestFrame.params.session_id, profile: 'yaoyao', ...(payload ? { payload } : {}) },
          }))
          if (requestFrame.params.text === '验证工具和文件权限') {
            const tool_id = `file-test-${Date.now()}`
            emit('message.start', {})
            emit('tool.generating', { name: 'terminal' })
            emit('tool.start', { tool_id, name: 'terminal', args: { command: '创建测试图片' } })
            emit('tool.complete', { tool_id, name: 'terminal', result: { output: '', exit_code: 0 } })
            emit('message.complete', { text: '已完成。\n\nMEDIA: /tmp/hello.png', status: 'complete' })
            return
          }
          if (requestFrame.params.text === '验证流式分段') {
            emit('message.start')
            emit('message.delta', { text: '我先检查配置。' })
            emit('message.interim', { text: '我先检查配置。', already_streamed: true })
            emit('tool.start', { tool_id: 'fake-tool', name: 'terminal', arguments: { command: 'pwd' } })
            setTimeout(() => {
              emit('tool.complete', { tool_id: 'fake-tool', name: 'terminal', result: { output: '/tmp' } })
              emit('message.delta', { text: '配置检查完成。' })
            }, 800)
            setTimeout(() => emit('message.complete', { text: '配置检查完成。', status: 'complete' }), 2_500)
            return
          }
          client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', session_id: requestFrame.params.session_id, profile: 'yaoyao' } }))
          client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: requestFrame.params.session_id, profile: 'yaoyao', payload: { text: '这是来自假 Gateway 的流式回复。' } } }))
          client.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: requestFrame.params.session_id, profile: 'yaoyao', payload: { text: '这是来自假 Gateway 的流式回复。', status: 'complete' } } }))
        }, requestFrame.params.text === '请开始思考' ? 3500 : 1200)
        return
      }
      respond({ ok: true })
    })
  })
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`Fake Hermes listening on 127.0.0.1:${port}\n`))
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)))
