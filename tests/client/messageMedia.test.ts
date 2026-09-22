import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'
import { normalizeChatMessage } from '@/utils/normalize'
import { chatMessageToUi, workspaceMessagesToUi } from '@/components/workspace/viewModels'
import type { WorkspaceMessage } from '@shared/workspace'

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
  it.each([
    '/Users/samien/Agents/zhuer/2026-09-22/dingtalk-current-page.png',
    '/tmp/截图 文件(1).png',
    '/tmp/screenshot%20copy.png',
  ])('renders a workspace MEDIA reference and its archived attachment once: %s', async sourcePath => {
    const original: WorkspaceMessage = {
      id: 'screenshot', conversationId: 'chat', seq: 1, role: 'assistant', agentId: 'bot',
      content: `当前画面：\n\nMEDIA:${sourcePath}\n\n截图完成。`, reasoning: '',
      status: 'complete', createdAt: 1, tools: [],
      attachments: [{ id: 'screenshot-file', name: sourcePath.split('/').at(-1)!, sourcePath, mimeType: 'image/png', size: 3590111, sender: 'agent', createdAt: 1 }],
    }
    const message = workspaceMessagesToUi([original])[0]!
    const wrapper = mount(MarkdownContent, { props: {
      content: message.content, attachments: message.attachments, separateMedia: true, fileCards: true, legacyMedia: true,
    } })
    expect(wrapper.findAll('.message-media')).toHaveLength(1)
    expect(wrapper.get('img').attributes('src')).toBe('/api/app/files/screenshot-file/preview')
    expect([...wrapper.get('.message-parts').element.children].map(el => el.className)).toEqual(['message-prose', 'message-media', 'message-prose'])
    await wrapper.get('.message-media__image').trigger('click')
    expect(wrapper.emitted('preview')?.[0]?.[0]).toEqual(message.attachments![0])
    expect(original.content).toContain(`MEDIA:${sourcePath}`)
    wrapper.unmount()
  })
  it('reconciles a late workspace attachment without duplicating the streamed image or hiding a distinct same-name file', async () => {
    const original: WorkspaceMessage = {
      id: 'stream', conversationId: 'chat', seq: 1, role: 'assistant', agentId: 'bot',
      content: 'MEDIA:/tmp/first/screenshot.png\n', reasoning: '', status: 'streaming', createdAt: 1, tools: [], attachments: [],
    }
    const props = () => {
      const message = workspaceMessagesToUi([original])[0]!
      return { content: message.content, attachments: message.attachments, streaming: message.status === 'streaming' }
    }
    const wrapper = mount(MarkdownContent, { props: { ...props(), separateMedia: true, fileCards: true, legacyMedia: true } })
    expect(wrapper.findAll('img')).toHaveLength(1)
    original.status = 'complete'
    original.attachments = ['first', 'second'].map(id => ({ id, name: 'screenshot.png', sourcePath: `/tmp/${id}/screenshot.png`, mimeType: 'image/png', size: 123, sender: 'agent', createdAt: 1 }))
    await wrapper.setProps(props())
    expect(wrapper.findAll('img').map(image => image.attributes('src'))).toEqual(['/api/app/files/first/preview', '/api/app/files/second/preview'])
    wrapper.unmount()
  })
})
