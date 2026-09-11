import { describe, expect, it } from 'vitest'
import { normalizeAssistantMediaMarkdown } from '@/utils/mediaMarkdown'
import MarkdownIt from 'markdown-it'

function destinations(value: string): string[] {
  return new MarkdownIt().parse(value, {}).flatMap(token => (token.children ?? []).flatMap(child => {
    const path = child.type === 'image' ? child.attrGet('src') : child.type === 'link_open' ? child.attrGet('href') : null
    return path ? [decodeURIComponent(path)] : []
  }))
}

describe('historical assistant MEDIA compatibility', () => {
  it('converts image and non-image paths to valid Markdown with round-trip filenames', () => {
    const rendered = normalizeAssistantMediaMarkdown('MEDIA:/Users/samien/图片 文件.jpg\nMEDIA:/tmp/报告.docx')
    expect(destinations(rendered)).toEqual(['/Users/samien/图片 文件.jpg', '/tmp/报告.docx'])
    expect(rendered).toContain('![图片 文件.jpg]')
  })

  it('accepts quoted paths with Chinese, spaces, quotes, and backticks', () => {
    const paths = ["/Users/瑶儿/带 空格 '引号'.png", '/tmp/含`反引号`.pdf']
    const rendered = normalizeAssistantMediaMarkdown(paths.map(path => `MEDIA:"${path}"`).join('\n'))
    expect(destinations(rendered)).toEqual(paths)
  })

  it('waits for a streaming path boundary and accepts a closed quoted path', () => {
    expect(normalizeAssistantMediaMarkdown('MEDIA:/tmp/正在生成.png', true)).toBe('MEDIA:/tmp/正在生成.png')
    expect(destinations(normalizeAssistantMediaMarkdown('MEDIA:/tmp/正在生成.png\n下一行', true))).toEqual(['/tmp/正在生成.png'])
    expect(destinations(normalizeAssistantMediaMarkdown('MEDIA:`/tmp/已完整.png`', true))).toEqual(['/tmp/已完整.png'])
  })

  it('does not transform code, headings, tables, URLs, or traversal paths', () => {
    const input = [
      '```text',
      'MEDIA:/tmp/inside-code.png',
      '```',
      '`MEDIA:/tmp/inline.png`',
      '# MEDIA:/tmp/title.png',
      '| MEDIA:/tmp/table.png | value |',
      'MEDIA:https://example.com/remote.png',
      'MEDIA:/tmp/../secret.png',
    ].join('\n')
    expect(normalizeAssistantMediaMarkdown(input)).toBe(input)
  })
})
