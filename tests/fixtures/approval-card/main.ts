// Isolated visual fixture: no application API requests or user data writes.
import { createApp, defineComponent, h, ref } from 'vue'
import WorkspaceApprovalCard from '@/components/workspace/WorkspaceApprovalCard.vue'
import '@/styles/tokens.css'
import '@/styles/global.css'

const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.has('dark'))
createApp(defineComponent({ setup() {
  const busy = ref(false), result = ref(''), automatic = ref(false)
  async function choose(choice: 'once'|'deny'|'auto') {
    busy.value = true
    await new Promise(resolve => setTimeout(resolve, 600))
    automatic.value = choice === 'auto'
    result.value = choice === 'auto' ? '自动允许已开启，后续不再询问' : choice === 'once' ? '已允许本次操作' : '已拒绝本次操作'
    busy.value = false
  }
  return () => h('main', { style: 'min-height:100dvh;display:grid;place-items:center;background:var(--surface);color:var(--text-primary)' }, [
    h('div', { style: 'width:100%;max-width:390px;padding:16px;box-sizing:border-box' }, result.value ? [
      h('p', { role: 'status' }, result.value),
      h('button', { onClick: () => { result.value = automatic.value ? '已自动允许下一次操作' : '' } }, '模拟下一次审批'),
      h('button', { onClick: () => { result.value = ''; automatic.value = false } }, '重新预览'),
    ] : h(WorkspaceApprovalCard, { prompt: query.has('long') ? '运行工具：' + '请核对下面的工具参数与文件路径。'.repeat(80) : '瑶儿想调用图片生成工具', busy: busy.value, onChoose: choose })),
  ])
} })).mount('#app')
