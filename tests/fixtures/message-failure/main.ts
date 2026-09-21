import { createApp, defineComponent, h } from 'vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import '@/styles/tokens.css'
import '@/styles/global.css'
const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.has('dark'))
const error = 'Codex stream produced no SSE events for 120s after the first parsed event (threshold: 120s)'
createApp(defineComponent({ setup() {
  return () => h('main', { style: `height:100dvh;max-width:${query.has('mobile') ? '375px' : '900px'};margin:auto;display:flex;flex-direction:column;border-inline:1px solid var(--line)` }, [
    h(WorkspaceMessageTimeline, { identity: 'preview', title: '瑶儿', showAssistantIdentity: false, messages: [
      { id: 'u', role: 'user', content: '帮我整理一下今天的内容' },
      { id: 'a', role: 'assistant', content: '我已经整理了第一部分，正在继续处理剩余内容。', error, status: 'failed', runId: 'one' },
      { id: 's', role: 'system', content: `执行失败：${error}`, status: 'failed', runId: 'one' },
      { id: 'u2', role: 'user', content: '再试一次' },
      { id: 'a2', role: 'assistant', content: `执行失败：${error}`, error, status: 'failed' },
    ] }),
  ])
} })).mount('#app')
