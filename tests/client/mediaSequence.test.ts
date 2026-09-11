import { describe, expect, it } from 'vitest'
import { mediaItemsFromMessages, mediaUrlIdentity, previewItemFromUrl } from '@/components/library/mediaSequence'
import type { UiMessage } from '@/components/messages/types'

describe('conversation media sequence', () => {
  it('keeps visible image and video order while deduplicating the same URL', () => {
    const messages: UiMessage[] = [
      { id: 'one', role: 'assistant', content: '![第一张](/media/first.png)' },
      { id: 'two', role: 'assistant', content: '[视频](/media/second.mp4)', attachments: [{ id: 'a', name: '第一张.png', kind: 'image', url: '/media/first.png' }] },
      { id: 'three', role: 'assistant', content: '普通文本', attachments: [{ id: 'b', name: '第三张.webp', kind: 'image', url: '/media/third.webp' }] },
      { id: 'four', role: 'assistant', content: 'MEDIA:/media/fourth.png' },
    ]
    expect(mediaItemsFromMessages(messages).map(item => [item.name, item.kind, item.previewUrl])).toEqual([
      ['first.png', 'image', '/media/first.png'],
      ['second.mp4', 'video', '/media/second.mp4'],
      ['第三张.webp', 'image', '/media/third.webp'],
      ['fourth.png', 'image', '/media/fourth.png'],
    ])
  })

  it('infers full-view media kind from a clicked conversation link', () => {
    expect(previewItemFromUrl('片段.webm', '/media/clip.webm')).toMatchObject({ kind: 'video', previewUrl: '/media/clip.webm' })
  })

  it('gives rendered and source Chinese paths the same media identity', () => {
    expect(mediaUrlIdentity('/Users/samien/Agents/瑶儿/单视角图片.png')).toBe(
      mediaUrlIdentity('/Users/samien/Agents/%E7%91%B6%E5%84%BF/%E5%8D%95%E8%A7%86%E8%A7%92%E5%9B%BE%E7%89%87.png'),
    )
  })

  it('uses the same Profile-scoped URL and filename as rendered server images', () => {
    const items = mediaItemsFromMessages([
      { id: 'one', role: 'assistant', profile: 'yaoer', content: 'MEDIA:/Users/test/工作/图片.png\n![第二张](/Users/test/工作/第二张.png)' },
    ])
    expect(items.map(item => item.name)).toEqual(['图片.png', '第二张.png'])
    const url = new URL(items[0]!.previewUrl!, window.location.origin)
    expect(url.pathname).toBe('/api/files/download')
    expect(url.searchParams.get('path')).toBe('/Users/test/工作/图片.png')
    expect(url.searchParams.get('profile')).toBe('yaoer')
    expect(items.every(item => item.kind === 'image')).toBe(true)
  })

  it('matches retried media without merging different Profile authorizations', () => {
    const original='/api/files/download?path=%2Fwork%2Fa.png&preview=1&profile=one'
    expect(mediaUrlIdentity(original)).toBe(mediaUrlIdentity(original+'&_retry=123'))
    expect(mediaUrlIdentity(original)).not.toBe(mediaUrlIdentity(original.replace('profile=one','profile=two')))
  })
})
