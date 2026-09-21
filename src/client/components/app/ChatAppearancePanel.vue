<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import { useChatAppearance } from '@/stores/chatAppearance'
import { appearancePreset, automaticText, bubbleColors, bubblePresets, bubbleSwatches, bubbleVariables, validHex, type BubbleRole, type BubbleStyle, type ChatAppearance } from '@/utils/chatAppearance'
import '@/styles/chat-bubbles.css'

const props = withDefaults(defineProps<{ theme?: 'light' | 'dark' }>(), { theme: 'light' })
const { appearance, previous, saveError, update, selectPreset, undo } = useChatAppearance()
const role = ref<BubbleRole>('user')
const shapeOpen = ref(window.innerWidth >= 1000)
const previewTheme = ref<'light' | 'dark'>(props.theme)
const hex = ref(''), endHex = ref(''), invalid = ref(false)
const current = computed(() => appearance.value[role.value])
const colorKey = computed(() => previewTheme.value === 'dark' ? 'dark' : 'light')
const endKey = computed(() => previewTheme.value === 'dark' ? 'darkEnd' : 'lightEnd')
const name = computed(() => bubblePresets.find(p => p.id === appearance.value.preset)?.name || '自定义')
watch([current, previewTheme], () => { hex.value = current.value[colorKey.value]; endHex.value = current.value[endKey.value]; invalid.value = false }, { immediate: true })
function edit(patch: Partial<BubbleStyle>) {
  const next = JSON.parse(JSON.stringify(appearance.value)) as ChatAppearance
  next.preset = 'custom'
  Object.assign(next[role.value], patch)
  if ('light' in patch || 'lightEnd' in patch || 'gradient' in patch) next[role.value].lightText = automaticText(next[role.value].light, next[role.value].gradient ? next[role.value].lightEnd : next[role.value].light)
  if ('dark' in patch || 'darkEnd' in patch || 'gradient' in patch) next[role.value].darkText = automaticText(next[role.value].dark, next[role.value].gradient ? next[role.value].darkEnd : next[role.value].dark)
  update(next)
}
function color(value: string, end = false) {
  const normalized = value.startsWith('#') ? value : `#${value}`
  invalid.value = !validHex(normalized)
  if (!invalid.value) edit({ [end ? endKey.value : colorKey.value]: normalized.toUpperCase() })
}
const textColor = computed(() => bubbleColors(current.value, previewTheme.value === 'dark').text)
</script>

<template>
  <section class="bubble-settings" aria-label="聊天气泡设置">
    <div class="bubble-controls">
      <p class="bubble-intro">选一套预设，也可以按喜好微调。</p>
      <p class="bubble-scope">应用到 <strong>所有会话</strong><span>仅当前设备</span></p>
      <section aria-label="预设样式">
        <h4>预设样式</h4><p class="bubble-hint">点击即可应用</p>
        <div class="bubble-presets" role="group" aria-label="气泡预设">
          <button v-for="preset in bubblePresets" :key="preset.id" type="button" :aria-pressed="appearance.preset === preset.id" :data-testid="`bubble-preset-${preset.id}`" @click="selectPreset(preset.id)">
            <span class="preset-sample" :data-bubble-theme="previewTheme" aria-hidden="true"><span class="chat-bubble sample-user" :style="bubbleVariables(appearancePreset(preset.id).user, 'user')">你好</span><span class="chat-bubble sample-assistant" :style="bubbleVariables(appearancePreset(preset.id).assistant, 'assistant')">我在</span></span>
            <AppIcon v-if="appearance.preset === preset.id" class="preset-check" name="check" :size="15" />
            <strong>{{ preset.name }}</strong><small>{{ preset.detail }}</small>
          </button>
        </div>
      </section>
      <section class="bubble-custom" aria-label="自定义微调">
        <h4>自定义微调</h4>
        <div class="bubble-segment" role="group" aria-label="调整哪一方"><button type="button" :aria-pressed="role === 'user'" @click="role = 'user'">我的气泡</button><button type="button" :aria-pressed="role === 'assistant'" @click="role = 'assistant'">助手气泡</button></div>
        <div class="bubble-field"><strong>背景</strong><div class="bubble-segment fill-segment" role="group" aria-label="背景类型"><button type="button" :aria-pressed="!current.gradient" @click="edit({ gradient: false })">纯色</button><button type="button" :aria-pressed="current.gradient" @click="edit({ gradient: true })">渐变</button></div></div>
        <div class="bubble-swatches" role="group" aria-label="快捷颜色"><button v-for="swatch in bubbleSwatches" :key="swatch" type="button" :aria-label="`选择颜色 ${swatch}`" :aria-pressed="current[colorKey] === swatch" @click="color(swatch)"><span :style="{ background: swatch, color: automaticText(swatch) }"><AppIcon v-if="current[colorKey] === swatch" name="check" :size="18" /></span></button></div>
        <label class="bubble-field"><span>{{ current.gradient ? '起始颜色' : '自定义颜色' }}</span><div class="bubble-color-input"><input type="color" :value="current[colorKey]" aria-label="选择自定义颜色" @change="color(($event.target as HTMLInputElement).value)"/><input v-model="hex" aria-label="颜色十六进制值" maxlength="7" spellcheck="false" :aria-invalid="invalid" @change="color(hex)" @keydown.enter="color(hex)" /></div></label>
        <label v-if="current.gradient" class="bubble-field"><span>结束颜色</span><div class="bubble-color-input"><input type="color" :value="current[endKey]" aria-label="选择渐变结束颜色" @change="color(($event.target as HTMLInputElement).value, true)"/><input v-model="endHex" aria-label="渐变结束颜色值" maxlength="7" :aria-invalid="invalid" @change="color(endHex, true)" /></div></label>
        <p v-if="invalid" class="bubble-error" role="alert">请输入有效的六位颜色，例如 #E4F3FC。</p>
        <div class="bubble-field"><span>文字颜色</span><span class="auto-text"><i :style="{ background: textColor }" />自动适配</span></div>
        <details class="bubble-shape" :open="shapeOpen"><summary>圆角、边框与尾巴<AppIcon name="chevron-down" :size="16" /></summary><div class="bubble-shape-fields">
          <label class="bubble-field"><span>圆角</span><input type="range" min="4" max="28" step="1" :value="current.radius" aria-label="气泡圆角" @change="edit({ radius: Number(($event.target as HTMLInputElement).value) })"/><output>{{ current.radius }}</output></label>
          <label class="bubble-field"><span>边框</span><input type="checkbox" role="switch" :checked="current.border" @change="edit({ border: ($event.target as HTMLInputElement).checked })"/></label>
          <label class="bubble-field"><span>显示尾巴</span><input type="checkbox" role="switch" :checked="current.tail" @change="edit({ tail: ($event.target as HTMLInputElement).checked })"/></label>
        </div></details>
      </section>
    </div>
    <aside class="bubble-preview" :data-bubble-theme="previewTheme" :class="{ 'preview-dark': previewTheme === 'dark' }" aria-label="实时预览">
      <header><h4>实时预览</h4><div class="preview-modes" role="group" aria-label="预览主题"><button type="button" aria-label="预览浅色气泡" :aria-pressed="previewTheme === 'light'" @click="previewTheme = 'light'"><AppIcon name="sun" :size="18" /></button><button type="button" aria-label="预览深色气泡" :aria-pressed="previewTheme === 'dark'" @click="previewTheme = 'dark'"><AppIcon name="moon" :size="18" /></button></div></header>
      <div class="preview-conversation">
        <div class="preview-row is-user"><div class="chat-bubble" :style="bubbleVariables(appearance.user, 'user')">帮我整理今天的工作重点。</div></div>
        <div class="preview-row"><AgentAvatar name="夭夭助手" :size="30" :animated="false"/><div><small>夭夭助手</small><div class="chat-bubble" :style="bubbleVariables(appearance.assistant, 'assistant')">当然，我们先聚焦三件事。</div></div></div>
        <div class="preview-row preview-extra"><AgentAvatar name="夭夭助手" :size="30" :animated="false"/><div><small>夭夭助手</small><div class="chat-bubble" :style="bubbleVariables(appearance.assistant, 'assistant')"><strong>今天的重点</strong><ol><li>梳理需求</li><li>确认优先级</li><li>安排下一步</li></ol></div></div></div>
        <div class="preview-row is-user preview-extra"><div class="chat-bubble" :style="bubbleVariables(appearance.user, 'user')">这样看起来更清楚了。</div></div>
      </div>
      <div class="preview-composer" aria-hidden="true"><AppIcon name="paperclip" :size="19"/><span>输入消息…</span><AppIcon name="arrow-up" :size="18"/></div>
    </aside>
    <footer class="bubble-footer"><button type="button" @click="selectPreset('current')">恢复默认</button><span role="status">{{ saveError || `已应用 ${name}` }}</span><button v-if="previous" type="button" class="bubble-undo" @click="undo">撤销</button></footer>
  </section>
</template>

<style scoped>
.bubble-settings{display:grid;grid-template-columns:minmax(290px,.95fr) minmax(310px,1.2fr);gap:24px;color:var(--text-primary);font-size:14px}.bubble-controls{min-width:0}.bubble-intro{margin:0 0 16px;color:var(--text-secondary);line-height:1.6}.bubble-scope{display:flex;align-items:center;gap:12px;margin:0 0 24px}.bubble-scope strong{font-weight:500}.bubble-scope>span{margin-left:auto;color:var(--text-secondary);font-size:12px}.bubble-settings h4{margin:0;font-size:15px;font-weight:650}.bubble-hint{margin:4px 0 12px;color:var(--text-secondary);font-size:12px}.bubble-presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.bubble-presets>button{position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0;padding:12px 8px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text-primary);font:inherit;cursor:pointer}.bubble-presets>button[aria-pressed=true]{outline:2px solid var(--text-primary);outline-offset:-2px}.bubble-presets strong{font-size:13px;white-space:nowrap}.bubble-presets small{font-size:11px;color:var(--text-secondary);white-space:nowrap}.preset-sample{display:flex;flex-direction:column;width:100%;gap:6px;margin-bottom:7px}.preset-sample .chat-bubble{padding:4px 9px;font-size:11px;line-height:1.4;max-width:80%;border-radius:8px}.sample-user{align-self:flex-end}.sample-assistant{align-self:flex-start}.preset-check{position:absolute;right:6px;top:6px;padding:2px;border-radius:50%;background:var(--text-primary);color:var(--surface)}.bubble-custom{display:grid;gap:10px;margin-top:22px;padding-top:20px;border-top:1px solid var(--line)}.bubble-segment{display:flex;padding:3px;border-radius:9px;background:var(--settings-panel)}.bubble-segment button{flex:1;min-height:36px;border:0;border-radius:7px;background:transparent;color:var(--text-secondary);font:inherit;cursor:pointer}.bubble-segment button[aria-pressed=true]{background:var(--text-primary);color:var(--surface)}.fill-segment{flex:1;max-width:250px}.fill-segment button[aria-pressed=true]{background:var(--surface);color:var(--text-primary);box-shadow:0 0 0 1px var(--line)}.bubble-field{display:flex;min-height:42px;align-items:center;justify-content:space-between;gap:12px}.bubble-field strong{font-weight:550}.bubble-swatches{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}.bubble-swatches button{display:grid;place-items:center;min-width:0;min-height:44px;padding:3px;border:0;border-radius:9px;background:transparent;cursor:pointer}.bubble-swatches span{display:grid;place-items:center;width:100%;aspect-ratio:1;max-width:40px;border-radius:8px;border:1px solid #0001}.bubble-swatches button[aria-pressed=true]{outline:2px solid var(--text-primary);outline-offset:-2px}.bubble-color-input{display:flex;gap:8px;align-items:center;max-width:210px}.bubble-color-input input{box-sizing:border-box;min-width:0;height:40px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text-primary);font:14px var(--font-ui)}.bubble-color-input input[type=color]{width:40px;flex:0 0 40px;padding:3px;cursor:pointer}.bubble-color-input input:not([type=color]){width:132px;padding:0 10px;text-transform:uppercase}.auto-text{display:flex;align-items:center;gap:8px;color:var(--text-secondary)}.auto-text i{width:12px;height:12px;border:1px solid var(--line);border-radius:50%}.bubble-shape{border-top:1px solid var(--line);padding-top:8px}.bubble-shape summary{display:flex;min-height:44px;align-items:center;justify-content:space-between;cursor:pointer;list-style:none}.bubble-shape summary::-webkit-details-marker{display:none}.bubble-shape-fields{display:grid;gap:4px}.bubble-field input[type=range]{width:55%;accent-color:var(--text-primary)}.bubble-field input[type=checkbox]{width:38px;height:24px;accent-color:var(--text-primary);cursor:pointer}.bubble-preview{align-self:start;position:sticky;top:0;display:flex;flex-direction:column;min-height:540px;border:1px solid var(--line);border-radius:12px;background:#fff;color:#202124;overflow:hidden}.bubble-preview header{display:flex;align-items:center;justify-content:space-between;padding:18px}.preview-modes{display:flex;background:#f1f1f3;border-radius:20px;padding:2px}.preview-modes button{display:grid;place-items:center;width:38px;height:34px;border:0;border-radius:18px;background:transparent;color:#6b6b72;cursor:pointer}.preview-modes button[aria-pressed=true]{background:white;color:#202124}.preview-conversation{display:grid;gap:26px;padding:22px 18px;flex:1;align-content:start}.preview-row{display:flex;align-items:flex-start;gap:9px;min-width:0}.preview-row>div{min-width:0;max-width:calc(100% - 38px)}.preview-row small{display:block;margin-bottom:8px;color:#65656e;font-size:12px}.preview-row.is-user{justify-content:flex-end}.preview-row.is-user>div{max-width:90%}.preview-row .chat-bubble{font-size:14px;line-height:1.7}.preview-row ol{padding-left:20px;margin:6px 0 0}.preview-composer{display:flex;align-items:center;gap:10px;padding:16px;margin:16px;border:1px solid #dedee3;border-radius:16px;color:#82828a}.preview-composer span{flex:1}.preview-dark{background:#181817;color:#efefec}.preview-dark .preview-row small{color:#b2b2ad}.preview-dark .preview-composer{border-color:#48484a}.bubble-footer{display:flex;align-items:center;gap:12px;grid-column:1/-1;border-top:1px solid var(--line);padding-top:10px;min-height:44px;font-size:13px}.bubble-footer>span{margin-left:auto;color:var(--text-secondary)}.bubble-footer button{min-height:44px;padding:0;border:0;background:transparent;color:var(--text-secondary);font:inherit;cursor:pointer}.bubble-footer .bubble-undo{color:var(--workflow-accent)}.bubble-error{margin:0;color:var(--danger);font-size:12px}.bubble-field input[type=checkbox]{appearance:none;position:relative;flex-shrink:0;border:1px solid var(--line);border-radius:20px;background:var(--settings-panel)}.bubble-field input[type=checkbox]::before{content:"";position:absolute;width:18px;height:18px;left:2px;top:2px;border-radius:50%;background:var(--surface);box-shadow:0 1px 3px #0003}.bubble-field input[type=checkbox]:checked{background:var(--text-primary)}.bubble-field input[type=checkbox]:checked::before{transform:translateX(14px)}.bubble-settings :is(button,input,summary):focus-visible{outline:2px solid var(--workflow-accent);outline-offset:2px}

@media(min-width:1000px){.bubble-footer{position:sticky;bottom:-24px;z-index:1;background:var(--surface);padding-bottom:8px}.bubble-intro{display:none}.bubble-scope{margin-bottom:8px}.bubble-presets>button{padding:10px 8px;gap:3px}.preset-sample{margin-bottom:0;gap:4px}.preset-sample .chat-bubble{padding:3px 8px;line-height:1.25}.bubble-custom{gap:4px;margin-top:12px;padding-top:10px}.bubble-field{min-height:36px}.bubble-shape-fields{gap:0}.bubble-preview{min-height:520px}.preview-conversation{gap:22px}}
@media(max-width:999px){.bubble-settings{grid-template-columns:1fr;gap:18px}.bubble-preview{position:static;grid-row:1;min-height:0}.preview-conversation{gap:14px;padding:4px 14px 16px}.bubble-preview header{padding:10px 14px}.preview-extra,.preview-composer{display:none}.bubble-controls{grid-row:2}.bubble-intro{display:none}.bubble-scope{margin-bottom:18px}.bubble-footer{grid-row:3}.bubble-custom{margin-top:18px}.preview-modes button{min-height:38px}.bubble-color-input input:not([type=color]){font-size:16px}}
</style>
