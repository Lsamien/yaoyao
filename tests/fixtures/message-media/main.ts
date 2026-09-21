import { createApp, defineComponent, h, ref } from 'vue'
import WorkspaceMessageTimeline from '@/components/workspace/WorkspaceMessageTimeline.vue'
import MessageTimeline from '@/components/messages/MessageTimeline.vue'
import type { UiMessage } from '@/components/messages/types'
import { useChatAppearance } from '@/stores/chatAppearance'
import '@/styles/tokens.css'
import '@/styles/global.css'
const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', query.has('dark'))
// Isolated fixture only: the product keeps the user's saved appearance.
useChatAppearance().selectPreset('grok')
const mobile = query.has('mobile')
const imageUrl = location.origin + '/tests/fixtures/message-media/bamboo.png'
const messages: UiMessage[] = [
  { id: 'u1', role: 'user', content: '随便发个文件给我看看' },
  { id: 'a1', role: 'assistant', content: '随便拿了一个小文本给你试打开。', attachments: [{ id: 'file', name: 'bamboo-sample.txt', size: 134, kind: 'file', url: '/tests/fixtures/message-media/bamboo-sample.txt' }] },
  { id: 'u2', role: 'user', content: '图片发一个' },
  { id: 'a2', role: 'assistant', content: `发一张试传。\n\n![竹叶](${imageUrl})` },
  { id: 'u3', role: 'user', content: '提示信息是什么样的？' },
  { id: 'a3', role: 'assistant', content: '提示会居中显示，点开可看详情。' },
  { id: 'notice', role: 'system', content: '任务已有新结果', taskReference: { conversationId: 'team', taskId: 'task' } },
]
if (query.has('order')) messages.splice(0, messages.length, { id:'order',role:'assistant',content:`第一段。\n\n![竹叶](${imageUrl})\n\n图片下面的文字。\n\n[bamboo-sample.txt](/api/app/files/file/download)\n\n最后一段。`,attachments:[{id:'file',name:'bamboo-sample.txt',size:134,kind:'file',url:'/api/app/files/file/download'}]})
createApp(defineComponent({ setup() {
  const opened = ref('')
  return () => h('main', { style: `height:100dvh;display:flex;flex-direction:column;${mobile ? 'max-width:390px;margin:auto;border-inline:1px solid var(--line)' : ''}` }, [
    h(query.has('ordinary') ? MessageTimeline : WorkspaceMessageTimeline, { identity:'media-preview',title:'竹儿',showAssistantIdentity:false,messages,onPreview:(file:any)=>opened.value=file.name,onPreviewFile:(file:any)=>opened.value=file.name }),
    h('footer', {style:'padding:12px 24px;border-top:1px solid var(--line);color:var(--text-muted)'}, '向竹儿提问'),
    opened.value ? h('dialog',{open:true,style:'position:fixed;inset:20% auto auto 50%;transform:translateX(-50%);border:1px solid var(--line);border-radius:20px;padding:24px;background:var(--surface);color:var(--text-primary)'},[h('p',opened.value), h('button',{onClick:()=>opened.value=''},'关闭预览')]) : null,
  ])
} })).mount('#app')
