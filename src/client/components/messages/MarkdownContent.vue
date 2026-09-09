<script setup lang="ts">
import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { copyTextToClipboard } from '@/utils/clipboard'
import { normalizeAssistantMediaMarkdown } from '@/utils/mediaMarkdown'
import { repairMarkdownForRender } from '@/utils/markdownRepair'

const props = withDefaults(defineProps<{
  content: string
  streaming?: boolean
  legacyMedia?: boolean
  plain?: boolean
  mentionNames?: string[]
  fileCards?: boolean
  processContent?: boolean
  outlinePrefix?: string
}>(), { streaming: false, legacyMedia: false, plain: false, fileCards: false, processContent: false, outlinePrefix: '' })

const emit = defineEmits<{ fileLink: [name: string, url: string]; rendered: [] }>()

const root = ref<HTMLElement | null>(null)
const copied = ref('')
const displayedContent = ref(props.content)
let renderTimer: ReturnType<typeof setTimeout> | undefined
function cancelRenderTimer() {
  if (renderTimer !== undefined) clearTimeout(renderTimer)
  renderTimer = undefined
}
// Throttle, not debounce: a continuous token stream must keep making progress.
watch(() => [props.content, props.streaming, props.plain] as const, ([content, streaming, plain]) => {
  if (!streaming || plain || !content.startsWith(displayedContent.value) || !displayedContent.value) {
    cancelRenderTimer()
    displayedContent.value = content
  } else if (renderTimer === undefined) {
    renderTimer = setTimeout(() => {
      renderTimer = undefined
      displayedContent.value = props.content
    }, 80)
  }
})
onBeforeUnmount(cancelRenderTimer)

// Completed code blocks retain their HTML as the trailing block grows.
const highlightedCode = new Map<string, string>()
let highlightCost = 0
function highlightCode(source: string, language: string): string {
  const key = `${language}\0${source}`
  const cached = highlightedCode.get(key)
  if (cached !== undefined) return cached
  const html = language && hljs.getLanguage(language)
    ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : escapeHtml(source)
  if (key.length + html.length <= 256_000) {
    highlightedCode.set(key, html)
    highlightCost += key.length + html.length
    while (highlightedCode.size > 32 || highlightCost > 512_000) {
      const oldest = highlightedCode.keys().next().value!
      highlightCost -= oldest.length + highlightedCode.get(oldest)!.length
      highlightedCode.delete(oldest)
    }
  }
  return html
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
  highlight(str: string, lang: string): string {
    const language = lang.trim().split(/\s+/)[0]?.toLowerCase() || ''
    const highlighted = highlightCode(str, language)
    const label = language || 'text'
    return `<pre class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(label)}</span><button type="button" class="code-copy" aria-label="复制代码">复制</button></div><code class="hljs language-${escapeHtml(label)}">${highlighted}</code></pre>`
  },
})

// Dashboard 规范：保留原文引号，不做智能引号替换。
md.disable('smartquotes')

const defaultImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, index, options, env, self) => {
  if (props.processContent) return escapeHtml(tokens[index].content || tokens[index].attrGet('src') || '图片')
  return defaultImage(tokens, index, options, env, self)
}

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  // Some assistants wrap real Hermes workspace paths in a sandbox: URI.
  // Resolve only this known file route before sanitizing the Markdown.
  const href = token.attrGet('href') || ''
  if (!props.processContent && props.fileCards && /^sandbox:\/Users\/[^/]+\/\.hermes\/(?:profiles\/[^/]+\/)?workspace\/.+/i.test(href)) {
    token.attrSet('href', href.slice('sandbox:'.length))
  }
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, index, options, env, self)
}

const markdownSource = computed(() => {
  let source = props.legacyMedia
    ? normalizeAssistantMediaMarkdown(displayedContent.value || '', props.streaming)
    : displayedContent.value || ''
  source = repairMarkdownForRender(source, props.streaming)
  return source
})

function highlightMentions(html: string): string {
  const names = props.mentionNames
  if (!names?.length) return html
  const escaped = [...new Set(names.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return html
  const re = new RegExp(`(?<![\\w])@(?:${escaped.join('|')})(?=$|[\\s.,!?;:，。！？；：)\\]}>])`, 'gi')
  return html.replace(re, match => `<span class="mention-highlight">${match}</span>`)
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(highlightMentions(html), {
    USE_PROFILES: { html: true },
    // MarkdownIt generates the inert code-copy button above. User-provided HTML
    // remains disabled, and DOMPurify still strips event-handler attributes.
    FORBID_TAGS: ['style', 'svg', 'math', 'form', 'input', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ADD_ATTR: ['target'],
  })
}

const renderedBlocks = computed(() => {
  if (props.plain) return []
  const env = {}
  const tokens = md.parse(markdownSource.value, env)
  const blocks: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < tokens.length; index++) {
    depth += tokens[index].nesting
    if (depth !== 0) continue
    blocks.push(sanitize(md.renderer.render(tokens.slice(start, index + 1), md.options, env)))
    start = index + 1
  }
  return blocks
})
watch(renderedBlocks, async () => {
  await nextTick()
  emit('rendered')
}, { flush: 'post' })

function decorateCopyButtons() {
  if (!root.value) return
  root.value.querySelectorAll<HTMLButtonElement>('pre .code-copy').forEach((button, index) => {
    if (button.dataset.bound) return
    button.dataset.bound = 'true'
    button.addEventListener('click', async () => {
      const code = button.closest('pre')?.querySelector('code')?.textContent ?? ''
      const key = `${index}:${code.length}`
      copied.value = key
      const copiedSuccessfully = await copyTextToClipboard(code)
      button.textContent = copiedSuccessfully ? '已复制' : '复制失败'
      button.setAttribute('aria-label', copiedSuccessfully ? '代码已复制' : '复制代码失败')
      window.setTimeout(() => {
        if (copied.value !== key || !button.isConnected) return
        copied.value = ''
        button.textContent = '复制'
        button.setAttribute('aria-label', '复制代码')
      }, 1400)
    })
  })
}

function decorateFileLinks() {
  if (props.processContent || !props.fileCards || !root.value) return
  root.value.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
    if (link.dataset.fileCard) return
    let url: URL
    try { url = new URL(link.href, window.location.href) } catch { return }
    const isAgentFile = /^\/Users\/[^/]+\/Agents\/.+/.test(url.pathname)
    const isWorkspaceFile = /^\/Users\/[^/]+\/\.hermes\/(?:profiles\/[^/]+\/)?workspace\/.+/.test(url.pathname)
    const isRemoteNodeFile = /^\/api\/app\/files\/(?:[0-9a-f-]{36}|[0-9]+)\/(?:download|preview)$/i.test(url.pathname)
    if (url.origin !== window.location.origin || (!isAgentFile && !isWorkspaceFile && !isRemoteNodeFile)) return
    link.dataset.fileCard = 'true'
    link.classList.add('file-link-card')
    link.removeAttribute('target')
    link.removeAttribute('rel')
    const name = link.textContent?.trim() || decodeURIComponent(url.pathname.split('/').at(-1) || '文件')
    link.setAttribute('aria-label', `预览文件 ${name}`)
    link.addEventListener('click', event => {
      event.preventDefault()
      emit('fileLink', name, `${url.pathname}${url.search}`)
    })
  })
}

function decorateMediaPreviews() {
  if (props.processContent || !props.fileCards || !root.value) return
  root.value.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    if (image.dataset.mediaPreview) return
    let url: URL
    try { url = new URL(image.currentSrc || image.src, window.location.href) } catch { return }
    if (url.origin !== window.location.origin) return
    image.dataset.mediaPreview = 'true'
    const name = decodeURIComponent(url.pathname.split('/').at(-1) || '图片')
    image.setAttribute('role', 'button')
    image.setAttribute('tabindex', '0')
    image.setAttribute('aria-label', `预览图片 ${name}`)
    const preview = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      emit('fileLink', name, `${url.pathname}${url.search}`)
    }
    image.addEventListener('click', preview)
    image.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') preview(event)
    })
  })
}

function decorateOutlineHeadings() {
  if (!props.outlinePrefix || !root.value) return
  root.value.querySelectorAll<HTMLElement>('h1, h2, h3').forEach((heading, index) => {
    heading.id = `${props.outlinePrefix}-heading-${index + 1}`
  })
}

function onClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a')
  if (!link) return
  const href = link.getAttribute('href') || ''
  if (/^(javascript|data|vbscript):/i.test(href)) event.preventDefault()
}

onMounted(() => { decorateCopyButtons(); decorateFileLinks(); decorateMediaPreviews(); decorateOutlineHeadings() })
onUpdated(() => { decorateCopyButtons(); decorateFileLinks(); decorateMediaPreviews(); decorateOutlineHeadings() })
</script>

<template>
  <div v-if="plain" class="plain-text">{{ content }}</div>
  <div v-else ref="root" class="markdown" :class="{ 'markdown--streaming': streaming }" @click="onClick">
    <div v-for="(html, index) in renderedBlocks" :key="index" class="markdown-block" v-html="html" />
  </div>
  <AppIcon v-if="streaming" class="stream-caret" name="arrow-up" :size="0" />
</template>

<style scoped>
.plain-text { min-width: 0; color: inherit; font-size: 13px; line-height: 1.68; white-space: pre-wrap; overflow-wrap: anywhere; }
.markdown-block { display: flow-root; }
.markdown { min-width: 0; color: inherit; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.markdown :deep(p) { margin: 0 0 10px; }.markdown-block:last-child :deep(> p:last-child) { margin-bottom: 0; }
.markdown :deep(h1), .markdown :deep(h2), .markdown :deep(h3), .markdown :deep(h4), .markdown :deep(h5), .markdown :deep(h6) { margin: 1.5em 0 .55em; color: var(--text-primary); line-height: 1.35; letter-spacing: -.01em; }
.markdown :deep(h1) { font-size: 1.5em; }.markdown :deep(h2) { font-size: 1.28em; }.markdown :deep(h3) { font-size: 1.12em; }.markdown :deep(h4), .markdown :deep(h5), .markdown :deep(h6) { font-size: 1em; }
.markdown :deep(ul), .markdown :deep(ol) { margin: .45em 0 10px; padding-left: 1.55em; }.markdown :deep(li) { margin: .32em 0; }
.markdown :deep(strong) { color: var(--text-primary); font-weight: 660; }
.markdown :deep(blockquote) { margin: 10px 0; padding: .15em 0 .15em 14px; border-left: 3px solid var(--line-strong); color: var(--text-secondary); }
.markdown :deep(a) { color: var(--text-primary); text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }.markdown :deep(a:hover) { text-decoration-color: currentColor; }
.markdown :deep(code) { padding: .14em .38em; border-radius: 5px; background: var(--surface-soft); color: var(--text-primary); font-family: var(--font-code); font-size: .9em; }
.markdown :deep(.code-block) { position: relative; margin: 12px 0; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft); overflow: hidden; }
.markdown :deep(.code-header) { display: flex; min-height: 30px; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--surface-hover) 55%, transparent); }
.markdown :deep(.code-lang) { color: var(--text-muted); font: 600 9px var(--font-ui); letter-spacing: .06em; text-transform: uppercase; }
.markdown :deep(.code-copy) { padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-raised); color: var(--text-muted); cursor: pointer; font: 500 9px var(--font-ui); }
.markdown :deep(.code-copy:hover) { color: var(--text-primary); }
.markdown :deep(.code-block code) { display: block; padding: 12px 14px; overflow: auto; background: transparent; color: var(--text-primary); font-size: 11px; line-height: 1.6; white-space: pre; }
.markdown :deep(table) { display: block; width: max-content; max-width: 100%; margin: 10px 0; overflow-x: auto; border-collapse: collapse; }
.markdown :deep(th), .markdown :deep(td) { padding: 6px 10px; border: 1px solid var(--line); text-align: left; }
.markdown :deep(th) { background: var(--surface-soft); color: var(--text-primary); font-weight: 640; }.markdown :deep(td) { color: var(--text-secondary); }
.markdown :deep(hr) { margin: 16px 0; border: 0; border-top: 1px solid var(--line); }
.markdown :deep(img) { display: block; width: auto; max-width: min(100%, 560px); max-height: 360px; margin: .7em 0; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); object-fit: contain; }.markdown :deep(img[data-media-preview]) { cursor: zoom-in; }
.markdown :deep(.file-link-card) { display: flex; width: min(390px, 100%); min-height: 52px; align-items: center; gap: 9px; margin: 8px 0; padding: 8px 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: 0 3px 10px rgba(0,0,0,.035); color: var(--text-primary); text-decoration: none; }.markdown :deep(.file-link-card)::before { display: grid; width: 27px; height: 27px; flex: 0 0 27px; place-items: center; border-radius: 7px; background: var(--surface-soft); color: var(--text-secondary); content: '▤'; font-size: 15px; }.markdown :deep(.file-link-card)::after { margin-left: auto; color: var(--text-muted); content: '预览'; font-size: 9px; }.markdown :deep(.file-link-card:hover) { border-color: var(--line-strong); background: var(--surface-soft); text-decoration: none; }
.markdown :deep(.mention-highlight) { padding: .08em .34em; border-radius: 6px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text-primary); font-weight: 600; }
.markdown--streaming > .markdown-block:last-child::after { content: ''; display: inline-block; width: 5px; height: 14px; margin-left: 3px; border-radius: 1px; background: currentColor; vertical-align: -2px; animation: caret 1s step-end infinite; }
.stream-caret { display: none; }
@keyframes caret { 50% { opacity: 0; } }
@media (max-width: 600px) { .markdown :deep(img) { max-height: 280px; } }
</style>
