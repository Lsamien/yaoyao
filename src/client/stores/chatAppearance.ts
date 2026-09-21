import { ref, readonly } from 'vue'
import { appearancePreset, normalizeAppearance, type ChatAppearance, type BubblePreset } from '@/utils/chatAppearance'

export const CHAT_APPEARANCE_KEY = 'hermes-yaoyao:chat-appearance:v1'
function load(): ChatAppearance {
  try { return normalizeAppearance(JSON.parse(window.localStorage.getItem(CHAT_APPEARANCE_KEY) || 'null')) }
  catch { return appearancePreset('current') }
}
const value = ref(load())
const previous = ref<ChatAppearance | null>(null)
const saveError = ref('')
function save(next: ChatAppearance, undoable = true) {
  const normalized = normalizeAppearance(next)
  if (JSON.stringify(normalized) === JSON.stringify(value.value)) return
  try {
    window.localStorage.setItem(CHAT_APPEARANCE_KEY, JSON.stringify(normalized))
    if (undoable) previous.value = JSON.parse(JSON.stringify(value.value))
    value.value = normalized
    saveError.value = ''
  } catch { saveError.value = '无法保存外观设置，请检查浏览器存储空间。' }
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === CHAT_APPEARANCE_KEY || event.key === null) { value.value = load(); previous.value = null }
})
export function useChatAppearance() {
  return {
    appearance: readonly(value), previous: readonly(previous), saveError: readonly(saveError),
    update: save,
    selectPreset: (preset: BubblePreset) => save(appearancePreset(preset)),
    undo: () => { if (previous.value) { const old = previous.value; save(old, false); if (!saveError.value) previous.value = null } },
  }
}
