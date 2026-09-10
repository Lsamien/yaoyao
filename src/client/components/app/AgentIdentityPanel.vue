<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Profile } from '@shared/types'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { listModelCatalog } from '@/api/agentManagement'
import type { ProfileIdentityInput } from '@/api/profiles'
import {
  AGENT_MASCOT_COLORS, AGENT_MASCOT_COLOR_LABELS,
  AGENT_MASCOT_EXPRESSIONS,
  AGENT_MASCOT_SHAPES,
  AGENT_MASCOT_SHAPE_OPTIONS,
  agentIdentityFromProfile,
  decodeAgentAvatar,
  AGENT_MASCOT_BODIES, AGENT_MASCOT_BODY_LABELS, AGENT_MASCOT_EXPRESSION_LABELS, AGENT_IMAGE_CROPS,
  type AgentMascotBody, type AgentImageCrop,
  defaultAgentIdentity,
  encodeAgentAvatar,
  type AgentAvatarMode,
  type AgentMascotExpression,
  type AgentMascotShape,
} from '@shared/agentIdentity'

const props = withDefaults(defineProps<{
  profile: Profile
  busy?: boolean
  error?: string
  formId?: string
  showActions?: boolean
  resetVersion?: number
  defaultModelLabel?: string
  embedded?: boolean
  showName?: boolean
  showDefaultModel?: boolean
}>(), {
  busy: false,
  error: '',
  formId: undefined,
  showActions: true,
  resetVersion: 0,
  defaultModelLabel: '',
  embedded: false,
  showName: true,
  showDefaultModel: true,
})
const emit = defineEmits<{
  save: [input: ProfileIdentityInput]
  'dirty-change': [dirty: boolean]
  avatarChange: [avatar: string]
}>()

const title = ref('')
const avatarDataURL = ref<string | null>(null)
const avatarMode = ref<AgentAvatarMode>('mascot')
const shape = ref<AgentMascotShape>('circle')
const color = ref('#00c875')
const bodyId = ref<AgentMascotBody | null>(null)
const imageCrop = ref<AgentImageCrop>('rounded')
const expression = ref<AgentMascotExpression>('idle')
const localError = ref('')
const fileInput = ref<HTMLInputElement>()
const baseline = ref('')
const resolvedDefaultModelLabel = ref('')
let profileGeneration = 0
let modelLoadGeneration = 0

function currentFingerprint(): string {
  return JSON.stringify({
    title: title.value,
    avatarMode: avatarMode.value,
    shape: shape.value,
    color: color.value,
    expression: expression.value,
  bodyId: bodyId.value, imageCrop: imageCrop.value,
    avatarDataURL: avatarDataURL.value,
  })
}

function resetFromProfile() {
  profileGeneration += 1
  const profile = props.profile
  const nextTitle = profile.agentName || profile.displayName || profile.name || ''
  const mascot = decodeAgentAvatar(profile.agentAvatar)
  const fallback = defaultAgentIdentity(profile.name, nextTitle)
  title.value = nextTitle
  avatarDataURL.value = mascot?.imageDataURL ?? null
  bodyId.value = mascot?.bodyId ?? null
  imageCrop.value = mascot?.imageCrop ?? 'rounded'
  avatarMode.value = mascot?.avatarMode ?? (avatarDataURL.value ? 'image' : 'mascot')
  shape.value = mascot?.shape ?? fallback.shape
  color.value = mascot?.color ?? fallback.color
  expression.value = mascot?.expression ?? fallback.expression
  baseline.value = currentFingerprint()
  localError.value = ''
}

watch([() => props.profile.name, () => props.resetVersion], resetFromProfile, { immediate: true })
watch([() => props.profile.name, () => props.defaultModelLabel], async () => {
  if (!props.showDefaultModel) return
  const generation = ++modelLoadGeneration
  const fallback = props.defaultModelLabel
    || [props.profile.provider, props.profile.model].filter(Boolean).join(' / ')
  resolvedDefaultModelLabel.value = fallback
  try {
    const current = (await listModelCatalog(props.profile.name))
      .find(provider => provider.isCurrent && provider.currentModel)
    if (generation === modelLoadGeneration && current?.currentModel) {
      resolvedDefaultModelLabel.value = `${current.slug} / ${current.currentModel}`
    }
  } catch { /* Keep the Profile payload as a read-only fallback. */ }
}, { immediate: true })

const previewAvatar = computed(() => encodeAgentAvatar({
  ...agentIdentityFromProfile({ name: props.profile.name, display_name: title.value }),
  displayName: title.value,
  avatarMode: avatarMode.value,
  shape: shape.value,
  color: color.value,
  expression: expression.value,
  bodyId: bodyId.value, imageCrop: imageCrop.value,
  ...(avatarDataURL.value ? { imageDataURL: avatarDataURL.value } : {}),
}))
watch(previewAvatar, value => emit('avatarChange', value), { immediate: true })
const identityFingerprint = computed(currentFingerprint)
const dirty = computed(() => identityFingerprint.value !== baseline.value)
watch(dirty, value => emit('dirty-change', value), { immediate: true })

const shapeLabel: Record<AgentMascotShape, string> = { circle: '圆形', square: '圆角方形', triangle: '小三角', ellipse: '椭圆', capsule: '胶囊', hexagon: '六边形', cloud: '云朵', droplet: '水滴' }
const expressionLabel = AGENT_MASCOT_EXPRESSION_LABELS

function mascotPreview(overrides: Partial<{
  shape: AgentMascotShape
  color: string
  expression: AgentMascotExpression
  bodyId: AgentMascotBody | null
}> = {}): string {
  return encodeAgentAvatar({
    ...agentIdentityFromProfile({ name: props.profile.name, display_name: title.value }),
    displayName: title.value,
    avatarMode: 'mascot',
    shape: overrides.shape ?? shape.value,
    color: overrides.color ?? color.value,
    expression: overrides.expression ?? expression.value,
    bodyId: overrides.bodyId === undefined ? bodyId.value : overrides.bodyId,
  })
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片'))
    reader.onerror = () => reject(new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

function resizeImage(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const edge = Math.min(256, Math.max(image.width, image.height))
      const ratio = edge / Math.max(image.width, image.height)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * ratio))
      canvas.height = Math.max(1, Math.round(image.height * ratio))
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('当前浏览器不支持图片处理'))
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('请选择有效的 PNG、JPEG 或 WebP 图片'))
    image.src = source
  })
}

async function chooseAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const generation = profileGeneration
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB')
    const nextAvatar = await resizeImage(await readImage(file))
    if (generation !== profileGeneration) return
    avatarDataURL.value = nextAvatar
    avatarMode.value = 'image'
    localError.value = ''
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : '处理头像失败'
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}

function randomizeAvatar() {
  avatarMode.value = 'mascot'
  bodyId.value = null
  shape.value = AGENT_MASCOT_SHAPES[Math.floor(Math.random() * AGENT_MASCOT_SHAPES.length)]!
  color.value = AGENT_MASCOT_COLORS[Math.floor(Math.random() * AGENT_MASCOT_COLORS.length)]!
  expression.value = AGENT_MASCOT_EXPRESSIONS[Math.floor(Math.random() * AGENT_MASCOT_EXPRESSIONS.length)]!
}
function resetAvatar() {
  const original = defaultAgentIdentity(props.profile.name, title.value)
  avatarMode.value = 'mascot'
  bodyId.value = null
  imageCrop.value = 'rounded'
  shape.value = original.shape
  color.value = original.color
  expression.value = original.expression
  avatarDataURL.value = null
}

function submit() {
  const normalized = title.value.trim().replace(/\s+/g, ' ')
  if (!normalized) { localError.value = '请输入机器人名称'; return }
  emit('save', {
    title: normalized,
    avatarMode: avatarMode.value,
    shape: shape.value,
    color: color.value,
    expression: expression.value,
  bodyId: bodyId.value, imageCrop: imageCrop.value,
    avatarDataURL: avatarDataURL.value,
  })
  title.value = normalized
}
</script>

<template>
  <component :is="embedded ? 'div' : 'form'" :id="formId" class="identity-form" @submit.prevent="submit">
    <div class="identity-avatar">
      <AgentAvatar :name="title || profile.name" :avatar="previewAvatar" :size="112" state="idle" :animated="true" />
      <div>
        <strong>自定义角色</strong>
        <small>头像设置保存后同步到 Web 与 iOS。</small>
        <p>
          <button class="quiet-button" :class="{ active: avatarMode === 'mascot' }" type="button" :disabled="busy" @click="avatarMode = 'mascot'">动态吉祥物</button>
          <button class="quiet-button" :class="{ active: avatarMode === 'image' }" type="button" :disabled="busy || !avatarDataURL" @click="avatarMode = 'image'">上传图片</button>
        </p>
        <p><button class="quiet-button" type="button" :disabled="busy" @click="fileInput?.click()"><AppIcon name="image" :size="14" />选择图片</button><button v-if="avatarDataURL" class="quiet-button" type="button" :disabled="busy" @click="avatarDataURL = null; avatarMode = 'mascot'">移除图片</button></p>
      </div>
      <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="chooseAvatar" />
    </div>
    <label v-if="showName">名称<input v-model="title" :disabled="busy" maxlength="100" autocomplete="off" /></label>
    <section v-if="avatarMode === 'mascot'" class="mascot-controls">
      <div>
        <strong>形状</strong>
        <div class="mascot-grid mascot-grid--shape">
          <button v-for="candidate in AGENT_MASCOT_SHAPE_OPTIONS" :key="candidate" type="button" :class="{ selected: !bodyId && shape === candidate }" :aria-pressed="!bodyId && shape === candidate" @click="shape = candidate; bodyId = null">
            <AgentAvatar :name="title || profile.name" :avatar="mascotPreview({ shape: candidate, bodyId: null })" :size="44" />
            <span>{{ shapeLabel[candidate] }}</span>
          </button>
        </div>
      </div>
      <div>
        <strong>造型</strong>
        <div class="mascot-grid mascot-grid--shape">
          <button v-for="candidate in AGENT_MASCOT_BODIES" :key="candidate" type="button" :class="{selected: bodyId === candidate}" :aria-pressed="bodyId === candidate" :aria-label="`造型：${AGENT_MASCOT_BODY_LABELS[candidate]}`" @click="bodyId = candidate">
            <AgentAvatar :name="AGENT_MASCOT_BODY_LABELS[candidate]" :avatar="mascotPreview({bodyId:candidate})" :size="44" :animated="false" /><span>{{ AGENT_MASCOT_BODY_LABELS[candidate] }}</span>
          </button>
        </div>
      </div>
      <div>
        <strong>基础表情</strong>
        <div class="mascot-grid mascot-grid--expression">
          <button v-for="candidate in AGENT_MASCOT_EXPRESSIONS" :key="candidate" type="button" :class="{ selected: expression === candidate }" :aria-pressed="expression === candidate" @click="expression = candidate">
            <AgentAvatar :name="title || profile.name" :avatar="mascotPreview({ expression: candidate })" :size="38" />
            <span>{{ expressionLabel[candidate] }}</span>
          </button>
        </div>
      </div>
      <div>
        <strong>颜色</strong>
        <div class="color-grid">
          <button v-for="candidate in AGENT_MASCOT_COLORS" :key="candidate" type="button" :class="{ selected: color === candidate }" :style="{ backgroundColor: candidate }" :aria-label="`使用颜色 ${candidate}`" :title="AGENT_MASCOT_COLOR_LABELS[candidate]" :aria-pressed="color === candidate" @click="color = candidate" />
        </div>
      </div>
    </section>
    <section v-if="avatarMode === 'image'" class="mascot-controls"><strong>图片裁剪</strong><div class="mascot-grid mascot-grid--shape"><button v-for="crop in AGENT_IMAGE_CROPS" :key="crop" type="button" :aria-pressed="imageCrop === crop" :class="{selected:imageCrop === crop}" @click="imageCrop = crop">{{ {circle:'圆形',rounded:'圆角方形',square:'方形'}[crop] }}</button></div></section>
    <div class="avatar-actions">
      <button class="quiet-button" type="button" :disabled="busy" @click="randomizeAvatar">随机外形</button>
      <button class="quiet-button" type="button" :disabled="busy" @click="resetAvatar">重置头像</button>
    </div>
    <div v-if="showDefaultModel" class="identity-default-model">
      <strong>默认全局模型</strong>
      <span>{{ resolvedDefaultModelLabel || '服务器未返回默认模型' }}</span>
      <small>仅影响之后新建的会话；已有会话保留自己的模型。</small>
    </div>
    <p v-if="localError || error" class="identity-error" role="alert">{{ localError || error }}</p>
    <footer v-if="showActions" class="identity-actions">
      <slot name="actions">
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在同步…' : '保存并同步' }}</button>
      </slot>
    </footer>
  </component>
</template>

<style scoped>
.identity-form{display:grid;max-width:720px}.identity-avatar{display:flex;align-items:flex-start;gap:24px;margin-bottom:32px;padding:0;background:transparent}.identity-avatar>div{display:grid;gap:7px;padding-top:4px}.identity-avatar strong{font-size:16px}.identity-avatar small{max-width:480px;color:var(--text-muted);font-size:13px;line-height:1.55}.identity-avatar p{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 0}.identity-form label{display:grid;max-width:480px;gap:8px;color:var(--text-secondary);font-size:14px;font-weight:650}.identity-form input:not(.sr-only){width:100%;min-height:46px;box-sizing:border-box;padding:0 13px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-raised);color:var(--text-primary);font:14px var(--font-ui);font-weight:400}.identity-form input:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px var(--focus-ring)}.quiet-button,.primary-button,.identity-actions :slotted(.quiet-button),.identity-actions :slotted(.primary-button){display:inline-flex;min-height:40px;align-items:center;justify-content:center;gap:7px;padding:0 14px;border:0;border-radius:9px;cursor:pointer;font-size:13px;font-weight:600}.quiet-button,.identity-actions :slotted(.quiet-button){border:1px solid var(--line);background:var(--surface-raised);color:var(--text-secondary)}.quiet-button.active{border-color:var(--accent);color:var(--text-primary);box-shadow:0 0 0 2px var(--focus-ring)}.primary-button,.identity-actions :slotted(.primary-button){min-width:118px;background:var(--accent);color:var(--text-on-solid)}.quiet-button:disabled,.primary-button:disabled,.identity-actions :slotted(.quiet-button:disabled),.identity-actions :slotted(.primary-button:disabled){cursor:wait;opacity:.5}.identity-error{margin:14px 0 0;color:var(--danger);font-size:13px}.identity-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:30px;padding-top:18px;border-top:1px solid var(--line)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.mascot-controls{display:grid;gap:22px;margin-top:24px}.mascot-controls>div{display:grid;gap:10px}.mascot-controls strong{color:var(--text-secondary);font-size:13px}.mascot-grid{display:grid;gap:9px}.mascot-grid--shape{grid-template-columns:repeat(4,minmax(0,1fr))}.mascot-grid--shape button{flex-direction:column}.avatar-actions{display:flex;gap:10px;margin-top:20px}.mascot-grid--expression{grid-template-columns:repeat(4,minmax(0,1fr))}.mascot-grid button{display:flex;min-height:78px;align-items:center;justify-content:center;gap:9px;padding:8px;border:1px solid var(--line);border-radius:12px;background:var(--surface-soft);color:var(--text-secondary);cursor:pointer}.mascot-grid button.selected{border-color:var(--accent);background:var(--surface-raised);color:var(--text-primary);box-shadow:0 0 0 2px var(--focus-ring)}.mascot-grid button span{font-size:12px;font-weight:650}.color-grid{display:flex;flex-wrap:wrap;gap:11px}.color-grid button{width:38px;height:38px;border:3px solid transparent;border-radius:50%;cursor:pointer;box-shadow:inset 0 0 0 1px rgb(255 255 255 / .2)}.color-grid button.selected{border-color:var(--surface);outline:2px solid var(--accent)}
@media(max-width:600px){.identity-avatar{align-items:flex-start;flex-direction:column}.identity-form label{max-width:none}}
.identity-default-model{display:grid;max-width:480px;gap:5px;margin-top:20px;padding:13px;border:1px solid var(--line);border-radius:9px;background:var(--surface-soft)}
.identity-default-model strong{color:var(--text-secondary);font-size:13px}.identity-default-model span{font:12px var(--font-code);overflow-wrap:anywhere}.identity-default-model small{color:var(--text-muted);font-size:11px}
</style>
