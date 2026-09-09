<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { decodeAgentAvatar, defaultAgentIdentity } from '@shared/agentIdentity'
import { mountCursorAvatar, type CursorState } from './maus/cursor-engine'
import { MASCOT_SILHOUETTES, LAOA_BODIES } from './maus/silhouettes'
type MascotState = 'idle' | 'working' | 'loading' | 'notifying' | 'waiting' | 'success' | 'failure'
const props = withDefaults(defineProps<{ name: string; avatar?: string; size?: number; state?: MascotState; animated?: boolean; fixedTime?: number; expressionIndex?: number; activityKey?: string | number }>(), { avatar: '', size: 32, state: 'idle', animated: undefined })
const host = ref<HTMLElement>(), svg = ref<SVGSVGElement>(), visible = ref(true), foreground = ref(true), reduced = ref(false), hover = ref(false)
const gaze = ref({x:0,y:0})
const oneShot = ref<CursorState>()
const beatEnded = ref(false), imageFailed = ref(false)
let beat: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | undefined
let media: MediaQueryList | undefined
let renderer: ReturnType<typeof mountCursorAvatar> | undefined
const identity = computed(() => decodeAgentAvatar(props.avatar) ?? defaultAgentIdentity(props.name))
const hasImage = computed(() => identity.value.avatarMode === 'image' && !!identity.value.imageDataURL && !imageFailed.value)
const radius = computed(() => identity.value.imageCrop === 'circle' ? '50%' : identity.value.imageCrop === 'square' ? '0' : '22%')
const states: Record<MascotState, CursorState> = {idle:'idle',working:'working',loading:'loading',waiting:'alerting',notifying:'notifying',success:'happy',failure:'sad'}
const runtimeActive = computed(() => props.state !== 'idle' && !beatEnded.value)
const state = computed<CursorState>(() => runtimeActive.value ? states[props.state] : oneShot.value ?? identity.value.expression)
const live = computed(() => visible.value && foreground.value && !reduced.value && props.animated !== false && (props.animated === true || props.size >= 56 || runtimeActive.value || !!oneShot.value || hover.value))
const options = computed(() => ({ state: state.value, paused: !live.value, color: identity.value.color, gaze: gaze.value,
  silhouette: identity.value.bodyId ? LAOA_BODIES[identity.value.bodyId] : MASCOT_SILHOUETTES[identity.value.shape === 'ellipse' ? 'oval' : identity.value.shape], fixedTime: props.fixedTime, expression: props.expressionIndex }))
function sync() {
  if (!svg.value || hasImage.value) { renderer?.dispose();renderer=undefined;return }
  if (!renderer) renderer=mountCursorAvatar(svg.value, options.value)
  else renderer.update(options.value)
}
function pointer(event: PointerEvent) {
  if (reduced.value || props.animated === false) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  hover.value=true
  gaze.value={x:Math.max(-1,Math.min(1,(event.clientX-rect.left)/rect.width*2-1)),y:Math.max(-1,Math.min(1,(event.clientY-rect.top)/rect.height*2-1))}
}
function leave() { hover.value=false;gaze.value={x:0,y:0} }
function visibility() { foreground.value=document.visibilityState!=='hidden' }
function motion() { reduced.value=media?.matches ?? false }
watch(() => props.avatar, () => { imageFailed.value=false })
watch(() => [props.state, props.activityKey] as const, ([next]) => {
  clearTimeout(beat);beatEnded.value=false;oneShot.value=undefined
  if(props.fixedTime === undefined && ['success','failure','notifying'].includes(next)) beat=setTimeout(()=>{beatEnded.value=true},1400)
},{immediate:true})
watch([options,svg,hasImage],sync,{flush:'post'})
onMounted(()=>{
  visibility();media=window.matchMedia?.('(prefers-reduced-motion: reduce)');motion();media?.addEventListener('change',motion)
  document.addEventListener('visibilitychange',visibility)
  if(typeof IntersectionObserver!=='undefined' && host.value){observer=new IntersectionObserver(entries=>{visible.value=entries[0]?.isIntersecting ?? false});observer.observe(host.value)}
  sync()
})
onBeforeUnmount(()=>{renderer?.dispose();observer?.disconnect();clearTimeout(beat);media?.removeEventListener('change',motion);document.removeEventListener('visibilitychange',visibility)})
</script>
<template>
  <span ref="host" class="agent-avatar" :class="[`agent-avatar--${props.state}`, {'agent-avatar--image':hasImage}]" :style="{width:`${size}px`,height:`${size}px`}" role="img" :aria-label="`${name} 的头像`" @pointermove="pointer" @pointerleave="leave" :data-animated="live && !hasImage" :data-expression="state">
    <img @error="imageFailed = true" v-if="hasImage" :src="identity.imageDataURL" alt="" :style="{borderRadius:radius}" />
    <svg v-else ref="svg" aria-hidden="true" />
  </span>
</template>
<style scoped>
.agent-avatar{display:block;position:relative;flex:0 0 auto;overflow:visible;line-height:1;background:transparent}.agent-avatar img,.agent-avatar svg{display:block;width:100%;height:100%;object-fit:cover}
</style>
