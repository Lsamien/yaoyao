<script setup lang="ts">
import AgentAvatar from '@/components/common/AgentAvatar.vue'
import TeamAvatar from '@/components/common/TeamAvatar.vue'
import { defaultAgentIdentity, encodeAgentAvatar, type AgentMascotShape } from '@shared/agentIdentity'
const avatar = (shape: AgentMascotShape) => encodeAgentAvatar({...defaultAgentIdentity('preview'), shape})

const shapes = [
  { name: '圆圆', avatar: avatar('circle') },
  { name: '方方', avatar: avatar('square') },
  { name: '小三角', avatar: avatar('triangle') },
] as const

const states = [
  { name: '工作中', detail: '状态驱动的眼睛和身体动作', avatar: avatar('triangle'), state: 'working' },
  { name: '有新消息', detail: '头像弹跳并提醒', avatar: avatar('triangle'), state: 'notifying' },
  { name: '等待你操作', detail: '状态驱动的眼睛和身体动作', avatar: avatar('square'), state: 'waiting' },
] as const

const teamMembers = shapes.map(item => ({ name: item.name, avatar: item.avatar }))
</script>

<template>
  <main class="identity-fixture">
    <header>
      <span>跨端角色系统</span>
      <h1>自定义机器人角色</h1>
      <p>采用 OpenMausBot 的纯色轮廓、五官与状态动画。</p>
    </header>
    <section class="shape-row" aria-label="三种头像形状">
      <article v-for="item in shapes" :key="item.name">
        <AgentAvatar :name="item.name" :avatar="item.avatar" :size="88" />
        <strong>{{ item.name }}</strong>
      </article>
    </section>
    <section class="state-list" aria-label="头像状态动画">
      <article v-for="item in states" :key="item.name">
        <AgentAvatar :name="item.name" :avatar="item.avatar" :size="58" :state="item.state" />
        <div><strong>{{ item.name }}</strong><span>{{ item.detail }}</span></div>
      </article>
    </section>
    <section class="group-preview" aria-label="群聊组合头像">
      <TeamAvatar name="产品设计团队" :members="teamMembers" fallback-key="design-team" :size="92" />
      <div><strong>产品设计团队</strong><span>群聊图标由成员角色自动组成</span></div>
    </section>
  </main>
</template>

<style scoped>
.identity-fixture{min-height:100vh;box-sizing:border-box;padding:72px clamp(28px,7vw,100px);background:var(--canvas);color:var(--text-primary)}header{max-width:850px}header>span{color:var(--accent);font-size:13px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}h1{margin:13px 0 12px;font-size:clamp(38px,5vw,68px);letter-spacing:-.045em;line-height:1.02}header p{max-width:720px;margin:0;color:var(--text-muted);font-size:18px;line-height:1.65}.shape-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));max-width:760px;gap:28px;margin-top:60px}.shape-row article{display:grid;place-items:center;gap:16px;min-height:160px;border:1px solid var(--line);border-radius:22px;background:var(--surface-raised)}.shape-row strong{font-size:14px}.state-list{display:grid;max-width:760px;gap:14px;margin-top:28px}.state-list article{display:flex;align-items:center;gap:20px;padding:19px 24px;border:1px solid var(--line);border-radius:20px;background:var(--surface-soft)}.state-list div{display:grid;gap:5px}.state-list strong{font-size:18px}.state-list span{color:var(--text-muted);font-size:13px}@media(max-width:620px){.identity-fixture{padding:44px 22px}.shape-row{gap:10px}.shape-row article{min-height:132px}.state-list article{padding:16px}}
.group-preview{display:flex;max-width:712px;align-items:center;gap:28px;margin-top:18px;padding:24px;border:1px solid var(--line);border-radius:22px;background:var(--surface-raised)}.group-preview>div{display:grid;gap:6px}.group-preview strong{font-size:20px}.group-preview span{color:var(--text-muted);font-size:13px}
</style>
