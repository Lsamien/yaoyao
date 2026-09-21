import { createApp, defineComponent, h } from 'vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'
import '@/styles/tokens.css'
import '@/styles/global.css'
const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.has('dark'))
const messages: UiMessage[] = [
  { id: 'user', role: 'user', content: '检查文章和配图，整理成预览包。' },
  { id: 'assigned', role: 'system', content: '由管理员分派的子任务：终审公众号预览包\n\n核验标题、事实来源和配图一致性。\n\n- 只核查内容\n- 提供可以执行的修改建议\n\n文件：`article.md`' },
  { id: 'answer', role: 'assistant', content: '文案和配图已完成。\n\n预览包已整理好，等待终审。' },
  { id: 'result', role: 'system', content: '「公众号文案团队」的任务「判断与执行拆分」已有执行结果，等待管理员复核。', taskReference: { conversationId: 'preview-team', taskId: 'preview-task' } },
  { id: 'timeout', role: 'assistant', content: '执行失败：请求超时', error: 'Codex stream produced no SSE events for 120s', status: 'failed' },
  { id: 'partial', role: 'assistant', content: '已完成第一项检查。', error: 'Connection closed while reading the response', status: 'failed' },
  { id: 'complete', role: 'system', content: '子任务结果已完成。\n\n完整核验记录保留在这里。', timelineKind: 'delegation-complete', timelineMetadata: { task_count: 3, completed_count: 3 } },
  { id: 'compaction', role: 'system', content: '[CONTEXT COMPACTION]\n\n已归档的摘要。', timelineKind: 'system' },
  { id: 'background', role: 'system', content: '后台检查完成，退出码 0。', timelineKind: 'background-process', timelineMetadata: { exit_code: 0 } },
]
const simple = query.has('reference')
createApp(defineComponent({ setup() {
  return () => h('main', { style: 'height:100dvh;display:flex;flex-direction:column' }, [
    h(query.has('ordinary') ? MessageTimeline : WorkspaceMessageTimeline, { identity: 'system-notice-preview', title: '公众号文案团队', showAssistantIdentity: false, messages: simple ? messages.slice(0, 4) : messages }),
  ])
} })).mount('#app')
