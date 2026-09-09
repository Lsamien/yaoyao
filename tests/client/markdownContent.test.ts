import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownContent from '@/components/messages/MarkdownContent.vue'

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
})

describe('MarkdownContent code copy', () => {
  it('copies code through the compatibility fallback and confirms success', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('NotAllowedError') }) },
    })
    let selectedText = ''
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        selectedText = (document.activeElement as HTMLTextAreaElement | null)?.value ?? ''
        return true
      }),
    })
    const wrapper = mount(MarkdownContent, {
      attachTo: document.body,
      props: { content: '```bash\necho "复制成功"\n```' },
    })
    await nextTick()

    const button = wrapper.find<HTMLButtonElement>('.code-copy')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await nextTick()

    expect(selectedText).toBe('echo "复制成功"\n')
    expect(button.text()).toBe('已复制')
    wrapper.unmount()
  })
})

describe('Markdown file cards', () => {
  it.each([
    '/Users/samien/.hermes/workspace/gpt-6-astra-report.md',
    '/Users/samien/.hermes/profiles/yaoer/workspace/详细 文档.md',
    'sandbox:/Users/samien/.hermes/workspace/gpt-6-astra-report.md',
    '/Users/samien/Agents/report.md',
    '/api/app/files/12/download',
  ])('renders a preview card for %s', async path => {
    const wrapper = mount(MarkdownContent, {
      props: { content: `[报告.md](<${path}>)`, fileCards: true },
    })
    const card = wrapper.get('a.file-link-card')
    expect(card.attributes('target')).toBeUndefined()
    expect(card.attributes('aria-label')).toBe('预览文件 报告.md')
    await card.trigger('click')
    expect(wrapper.emitted('fileLink')).toEqual([['报告.md', encodeURI(path.replace(/^sandbox:/, ''))]])
    wrapper.unmount()
  })

  it('preserves ordinary links and keeps unknown protocols sanitized', () => {
    const wrapper = mount(MarkdownContent, { props: { fileCards: true, content: [
      '[外部](https://example.com/Users/samien/.hermes/workspace/report.md)',
      '[普通](https://example.com/report.md)',
      '[配置](/Users/samien/.hermes/config.yaml)',
      '[未知](sandbox:/etc/passwd)',
    ].join('\n\n') } })
    expect(wrapper.find('.file-link-card').exists()).toBe(false)
    expect(wrapper.find('a[href^="sandbox:"]').exists()).toBe(false)
    expect(wrapper.findAll('a[href]')).toHaveLength(3)
    wrapper.unmount()
  })

  it('decorates workspace links arriving in a later message update', async () => {
    const wrapper = mount(MarkdownContent, { props: { content: '附件如下：', fileCards: true } })
    await wrapper.setProps({ content: '附件如下：\n\n[报告.md](/Users/samien/.hermes/workspace/report.md)' })
    expect(wrapper.find('a.file-link-card').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('streaming Markdown', () => {
  afterEach(() => vi.useRealTimers())

  it('formats before completion, preserves settled DOM blocks, and flushes the final token', async () => {
    vi.useFakeTimers()
    const prefix = '# 流式标题\n\n- 第一项\n- 第二项\n\n```ts\nconst x = '
    const wrapper = mount(MarkdownContent, { props: { content: prefix, streaming: true } })
    expect(wrapper.get('h1').text()).toBe('流式标题')
    expect(wrapper.findAll('li')).toHaveLength(2)
    expect(wrapper.get('pre code').element.textContent).toBe('const x = ')
    const heading = wrapper.get('h1').element
    const list = wrapper.get('ul').element
    await wrapper.setProps({ content: `${prefix}42` })
    await vi.advanceTimersByTimeAsync(80)
    expect(wrapper.get('pre code').text()).toContain('42')
    expect(wrapper.get('h1').element).toBe(heading)
    expect(wrapper.get('ul').element).toBe(list)
    await wrapper.setProps({ content: `${prefix}42\n\x60\x60\x60\n\n最后一个字`, streaming: false })
    expect(wrapper.text()).toContain('最后一个字')
    expect(wrapper.find('.markdown--streaming').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(wrapper.text()).toContain('最后一个字')
    wrapper.unmount()
  })

  it('does not starve while tokens arrive faster than the render interval', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MarkdownContent, { props: { content: '# 连续输出\n\n', streaming: true } })
    let content = '# 连续输出\n\n'
    for (let index = 0; index < 20; index++) {
      content += `${index} `
      await wrapper.setProps({ content })
      await vi.advanceTimersByTimeAsync(10)
      if (index === 10) expect(wrapper.text()).toContain('7')
    }
    await vi.advanceTimersByTimeAsync(80)
    expect(wrapper.text()).toContain('19')
    wrapper.unmount()
  })

  it('handles replacement, interruption, literal user text, and unmount during a pending update', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MarkdownContent, { props: { content: '```swift\nlet x = ', streaming: true } })
    await wrapper.setProps({ content: '```swift\nlet x = 1' })
    await wrapper.setProps({ streaming: false })
    expect(wrapper.get('pre code').text()).toContain('let x = 1')
    await wrapper.setProps({ content: '# 另一条消息', streaming: true })
    expect(wrapper.get('h1').text()).toBe('另一条消息')
    await vi.advanceTimersByTimeAsync(100)
    expect(wrapper.find('pre').exists()).toBe(false)
    await wrapper.setProps({ content: '**用户原文**', plain: true })
    expect(wrapper.get('.plain-text').text()).toBe('**用户原文**')
    expect(wrapper.find('strong').exists()).toBe(false)
    await wrapper.setProps({ content: '# 新内容', plain: false })
    await wrapper.setProps({ content: '# 新内容继续' })
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders split tables, links and emphasis safely and preserves the full long reply', async () => {
    vi.useFakeTimers()
    const source = '# 标题\n\n**粗体** 和 `行内代码`\n\n> 引用\n\n| 名称 | 数量 |\n| --- | --- |\n| 项目 | 2 |\n\n[链接](https://example.com)\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))'
    const wrapper = mount(MarkdownContent, { props: { content: '', streaming: true } })
    for (let index = 1; index <= source.length; index++) {
      await wrapper.setProps({ content: source.slice(0, index) })
      await vi.advanceTimersByTimeAsync(80)
    }
    expect(wrapper.get('strong').text()).toBe('粗体')
    expect(wrapper.get('blockquote').text()).toBe('引用')
    expect(wrapper.get('table').text()).toContain('项目')
    expect(wrapper.get('a').attributes('href')).toBe('https://example.com')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('a[href^="javascript:"]').exists()).toBe(false)
    const long = `${source}\n\n${'完整的长段落。\n\n'.repeat(400)}最终唯一标记`
    await wrapper.setProps({ content: long })
    await vi.advanceTimersByTimeAsync(80)
    expect(wrapper.text()).toContain('最终唯一标记')
    await wrapper.setProps({ streaming: false })
    expect(wrapper.text()).toContain('最终唯一标记')
    expect(wrapper.emitted('rendered')?.length).toBeGreaterThan(1)
    wrapper.unmount()
  })
})

it('renders process media as text while retaining message media previews', async () => {
  const content = '![过程图](/tmp/process.png) [过程文件](/Users/test/Agents/process.pdf)'
  const process = mount(MarkdownContent, { props: { content, processContent: true, fileCards: true } })
  await nextTick()
  expect(process.find('img').exists()).toBe(false)
  expect(process.find('.file-link-card').exists()).toBe(false)
  expect(process.text()).toContain('过程图')
  const message = mount(MarkdownContent, { props: { content, fileCards: true } })
  await nextTick()
  expect(message.find('img').exists()).toBe(true)
  expect(message.find('.file-link-card').exists()).toBe(true)
  process.unmount()
  message.unmount()
})
