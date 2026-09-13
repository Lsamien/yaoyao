from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/bot-latency-acceptance')
probe='''
const latencyTrace: Array<{ time: number; name: string; detail: string }> = []
;(window as any).__botLatency = latencyTrace
const recordLatency = (name: string, detail = '') => latencyTrace.push({ time: Date.now() / 1000, name, detail })
watch(busy, value => recordLatency(value ? 'send_start' : 'send_ready'), { flush: 'post' })
watch(() => messages.value.at(-1)?.content, () => {
  const m = messages.value.at(-1); recordLatency('view_text', `${m?.role}|${m?.status}|${m?.content.length ?? 0}`)
}, { flush: 'post' })
watch(() => messages.value.at(-1)?.status, status => {
  const m = messages.value.at(-1); if (status === 'complete' && m?.role === 'assistant') recordLatency('completed_text', m.content)
}, { flush: 'post' })
'''
for mode in ['baseline','optimized']:
 repo=r/f'{mode}-server'
 assert not (repo/'.git').exists(), 'Use a disposable source copy'
 p=repo/'src/client/views/ConversationsView.vue';s=p.read_text()
 assert '__botLatency' not in s, 'Copy is already instrumented'
 s=s.replace('onMounted(async () => {',probe+'\nonMounted(async () => {',1);p.write_text(s)
