import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'
import { normalizeChatMessage } from '@/utils/normalize'
import { chatMessageToUi, workspaceMessagesToUi } from '@/components/workspace/viewModels'

const attachments = [
  { id: 'doc', name: 'bamboo-sample.txt', size: 134, kind: 'file' as const, url: '/api/app/files/doc/download' },
  { id: 'pic', name: 'bamboo.jpg', kind: 'image' as const, url: '/api/app/files/pic/preview' },
]
describe('ordered message media', () => {
  it('keeps media between prose bubbles and deduplicates trailing attachments', async () => {
    const wrapper = mount(MarkdownContent, { props: {
      separateMedia: true, bubble: true, fileCards: true, attachments,
      content: '先看图片。\n\n![竹叶](/api/app/files/pic/preview)\n\n再看文件。\n\n[bamboo-sample.txt](/api/app/files/doc/download)\n\n最后一段。',
    } })
    expect([...wrapper.get('.message-parts').element.children].map(el => el.className)).toEqual(['message-prose chat-bubble', 'message-media', 'message-prose chat-bubble', 'message-file', 'message-prose chat-bubble'])
    expect(wrapper.findAll('.message-file')).toHaveLength(1)
    expect(wrapper.find('.chat-bubble img').exists()).toBe(false)
    expect(wrapper.get('.message-file__size').text()).toBe('134 B')
    await wrapper.get('.message-file').trigger('click')
    expect(wrapper.emitted('preview')?.[0]?.[0]).toEqual(attachments[0])
  })
  it('does not turn code examples or inline prose links into separate attachments', () => {
    const wrapper = mount(MarkdownContent, { props: { separateMedia: true, bubble: true, fileCards: true,
      content: '```md\n![示例](/api/app/files/pic/preview)\n```\n\n请阅读[文档](/api/app/files/doc/download)，然后继续。',
    } })
    expect(wrapper.findAll('.message-media, .message-file')).toHaveLength(0)
    expect(wrapper.get('.chat-bubble').text()).toContain('请阅读文档，然后继续。')
  })
  it('preserves typed content order through normalization without parsing user Markdown', () => {
    const message = chatMessageToUi(normalizeChatMessage({ id: 'ordered', role: 'user', content: [
      { type: 'text', text: '**原样文字**' },
      { type: 'file', id: 'doc', name: 'bamboo-sample.txt', url: '/api/app/files/doc/download', size: 134 },
      { type: 'text', text: '结尾' },
    ] }, 'session'))
    const wrapper = mount(MarkdownContent, { props: { content: message.content, attachments: message.attachments, contentParts: message.contentParts, separateMedia: true, bubble: true, plain: true } })
    expect([...wrapper.get('.message-parts').element.children].map(el => el.textContent)).toEqual(['**原样文字**', 'bamboo-sample.txt134 B', '结尾'])
  })
  it('retains workspace metadata after resolving an inline path', () => {
    const message = workspaceMessagesToUi([{ id: 'w', role: 'assistant', content: '[文件](/tmp/bamboo-sample.txt)', attachments: [{ id: 'doc', name: 'bamboo-sample.txt', size: 134, mimeType: 'text/plain', sourcePath: '/tmp/bamboo-sample.txt' }], tools: [], status: 'complete' } as any])[0]!
    const wrapper = mount(MarkdownContent, { props: { content: message.content, attachments: message.attachments, separateMedia: true, fileCards: true } })
    expect(wrapper.findAll('.message-file')).toHaveLength(1)
    expect(wrapper.text()).toBe('bamboo-sample.txt134 B')
  })
})
