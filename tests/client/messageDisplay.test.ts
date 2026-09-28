import { describe, expect, it } from 'vitest'
import { displayContentForMessage } from '@/utils/messageDisplay'
import { normalizeChatMessage } from '@/utils/normalize'

function expectImageDownload(url: string | undefined, path: string, profile = 'default') {
  const parsed = new URL(url!, 'https://yaoyao.test')
  expect(parsed.pathname).toBe('/api/files/download')
  expect(parsed.searchParams.get('path')).toBe(path)
  expect(parsed.searchParams.get('profile')).toBe(profile)
  expect(parsed.searchParams.get('preview')).toBe('1')
}

describe('displayContentForMessage', () => {
  it('turns persisted user @file markers into attachment cards and removes marker text', () => {
    const message = normalizeChatMessage({
      id: 'user-file', role: 'user', timestamp: 1,
      content: [
        '刘博士的技术介绍。',
        '',
        '[用户附加文件：大模型推理优化报告.docx]',
        '@file:\\/Users/samien/.hermes/attachments/大模型推理优化报告.docx',
        '',
        '[用户附加文件：MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx]',
        '@file:`/Users/samien/.hermes/attachments/MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx`',
      ].join('\n'),
    }, 'session-1', 'default')
    expect(message.content).toBe('刘博士的技术介绍。')
    expect(message.attachments).toEqual([
      expect.objectContaining({
        name: '大模型推理优化报告.docx',
        path: '/Users/samien/.hermes/attachments/大模型推理优化报告.docx',
        kind: 'file',
      }),
      expect.objectContaining({
        name: 'MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx',
        path: '/Users/samien/.hermes/attachments/MMLU_PRO_多模型协同评测系统_技术报告PPT_(1).pptx',
        kind: 'file',
      }),
    ])
  })

  it('turns iOS relative attachment markers into attachment cards', () => {
    const message = normalizeChatMessage({
      id: 'ios-user-file', role: 'user', timestamp: 1,
      content: [
        '[用户附加文件：车位 四号车库-B2307 罗益民 33600元.pdf]',
        '@file:`attachments/车位 四号车库-B2307 罗益民 33600元-2.pdf`',
        '',
        '--- Attached Context ---',
        '',
        '📎 @file:`attachments/车位 四号车库-B2307 罗益民 33600元-2.pdf` (application/pdf, 139.2 KB) — binary file.',
      ].join('\n'),
    }, 'session-1', 'default')

    expect(message.content).toBe('')
    expect(message.attachments).toEqual([
      expect.objectContaining({
        name: '车位 四号车库-B2307 罗益民 33600元.pdf',
        path: 'attachments/车位 四号车库-B2307 罗益民 33600元-2.pdf',
        url: '/attachments/%E8%BD%A6%E4%BD%8D%20%E5%9B%9B%E5%8F%B7%E8%BD%A6%E5%BA%93-B2307%20%E7%BD%97%E7%9B%8A%E6%B0%91%2033600%E5%85%83-2.pdf',
        kind: 'pdf',
      }),
    ])
  })

  it('turns iOS image markers into image attachments without keeping model screenshots', () => {
    const message = normalizeChatMessage({
      id: 'ios-user-image', role: 'user', timestamp: 1,
      content: [
        '测试',
        '',
        '[用户附加图片：照片-9270F5CF-2FE2-487F-8948-FA583F4C83B1.png]',
        '@image:/Users/samien/.hermes/images/upload_20260820_130901_1.png',
        '[screenshot]',
      ].join('\n'),
    }, 'session-1', 'default')

    expect(message.content).toBe('测试')
    expect(message.attachments).toEqual([
      expect.objectContaining({
        name: '照片-9270F5CF-2FE2-487F-8948-FA583F4C83B1.png',
        path: '/Users/samien/.hermes/images/upload_20260820_130901_1.png',
        kind: 'image',
      }),
    ])
    expectImageDownload(message.attachments?.[0]?.url, '/Users/samien/.hermes/images/upload_20260820_130901_1.png')
  })

  it('keeps multiple iOS image uploads together as image attachments', () => {
    const message = normalizeChatMessage({
      id: 'ios-user-images', role: 'user', timestamp: 1,
      content: [
        '[用户附加图片：照片-1.jpeg]',
        '',
        '[用户附加图片：照片-2.jpeg]',
        '@image:/Users/samien/.hermes/images/upload_1.jpeg',
        '@image:/Users/samien/.hermes/images/upload_2.jpeg',
        '[screenshot]',
        '[screenshot]',
      ].join('\n'),
    }, 'session-1', 'default')

    expect(message.content).toBe('')
    expect(message.attachments?.map(attachment => attachment.path)).toEqual([
      '/Users/samien/.hermes/images/upload_1.jpeg',
      '/Users/samien/.hermes/images/upload_2.jpeg',
    ])
  })

  it('restores an entire batch of iOS Profile images with their original names', () => {
    const names = ['照片-D2BE1E0F.png', '照片-8717030E.png', '中文 照片.heic']
    const paths = names.map((_, index) => `/Users/samien/.hermes/profiles/yaoer/images/upload_20260815_233834_${index + 1}.png`)
    const message = normalizeChatMessage({
      id: 'ios-profile-images', role: 'user', timestamp: 1,
      content: [
        '读取图片中的提示词',
        ...names.map(name => `[用户附加图片：${name}]`),
        ...paths.map(path => `@image:${path}`),
        ...paths.map(() => '[screenshot]'),
      ].join('\n'),
    }, 'session-1', 'yaoer')

    expect(message.content).toBe('读取图片中的提示词')
    expect(message.attachments?.map(({ name, path, kind }) => ({ name, path, kind })))
      .toEqual(names.map((name, index) => ({ name, path: paths[index], kind: 'image' })))
    message.attachments?.forEach((attachment, index) => expectImageDownload(attachment.url, paths[index]!, 'yaoer'))
  })

  it.each([
    ['/home/user/.hermes/images/demo.png', '/home/user/.hermes/images/demo.png'],
    ['/tmp/中文 照片.png', '/tmp/中文 照片.png'],
    ['/Users/samien/.hermes/profiles/yaoer/config/image.png', '/Users/samien/.hermes/profiles/yaoer/config/image.png'],
    ['file:///tmp/photo%20one.png', '/tmp/photo one.png'],
    ['/api/files/download?path=%2Ftmp%2Fphoto%20one.png', '/tmp/photo one.png'],
    ['/api/files/download?path=%2Ftmp%2F100%25.png', '/tmp/100%.png'],
  ])('restores cross-client image reference %s through the authenticated download route', (reference, path) => {
    const message = normalizeChatMessage({ role: 'user', content: `说明\n[用户附加图片：照片.png]\n@image:${reference}\n[screenshot]` }, 's', 'yaoer')
    expect(message.content).toBe('说明')
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments?.[0]?.path).toBe(path)
    expectImageDownload(message.attachments?.[0]?.url, path, 'yaoer')
  })

  it.each([
    '/api/app/files/id/preview',
    'file://remote/tmp/image.png',
    'file:///tmp/../secret.png',
    'file:///tmp/%2e%2e/secret.png',
    'https://other.test/image.png',
    '/api/files/download?path=%2Ftmp%2F..%2Fsecret.png',
    '/Users/samien/.hermes/profiles/../images/image.png',
    '/Users/samien/.hermes/profiles/yaoer/images/%2e%2e/image.png',
    '/Users/samien/.hermes/profiles/yaoer%2Fother/images/image.png',
    '/Users/samien/.hermes/profiles/yaoer/images/nested%2F..%2Fimage.png',
    '/Users/samien/.hermes/profiles/yaoer/images/image%5C.png',
    '/Users/samien/.hermes/profiles/yaoer/images/image%00.png',
  ])('keeps unsupported or unsafe image references as text: %s', path => {
    const content = `[用户附加图片：照片.png]\n@image:${path}\n[screenshot]`
    const message = normalizeChatMessage({ id: 'unsafe', role: 'user', content }, 'session-1', 'yaoer')
    expect(message.content).toBe(content)
    expect(message.attachments).toBeUndefined()
  })
  it('hides expanded attached context while restoring a missing reference', () => {
    const content = [
      '帮我看看这个文件',
      '',
      '--- Attached Context ---',
      '',
      '📄 @file:`/Users/samien/My Notes/方案.md` (981 tokens)',
      '```markdown',
      '# 很长的附加正文',
      '```',
    ].join('\n')

    expect(displayContentForMessage('user', content)).toBe(
      '@file:`/Users/samien/My Notes/方案.md`\n\n帮我看看这个文件',
    )
  })

  it('keeps visible references in place and deduplicates attached references', () => {
    const reference = '@url:`https://example.com/a b`'
    const content = [
      reference,
      '总结这篇文章',
      '',
      '--- Attached Context ---',
      '',
      `🌐 ${reference} (1200 tokens)`,
      '正文一',
      `🌐 ${reference} (1200 tokens)`,
      '正文二',
    ].join('\n')

    expect(displayContentForMessage('user', content)).toBe(`${reference}\n总结这篇文章`)
  })

  it('supports quoted refs and removes context warnings from user display', () => {
    const content = [
      '分析附件',
      '',
      '--- Attached Context ---',
      '',
      "📁 @folder:'/Users/samien/中文 文件夹' (20 tokens)",
      'folder listing',
      '🛠 @tool:"desktop capture" (10 tokens)',
      'tool output',
    ].join('\n')

    expect(displayContentForMessage('user', content)).toBe([
      "@folder:'/Users/samien/中文 文件夹'",
      '@tool:"desktop capture"',
      '',
      '分析附件',
    ].join('\n'))

    expect(displayContentForMessage('user', '继续\n\n--- Context Warnings ---\n抓取失败')).toBe('继续')
  })

  it('never rewrites assistant or system content', () => {
    const content = '回答\n\n--- Attached Context ---\n\n不应隐藏'
    expect(displayContentForMessage('assistant', content)).toBe(content)
    expect(displayContentForMessage('system', content)).toBe(content)
  })
})
