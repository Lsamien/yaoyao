import { createRouter, createWebHistory } from 'vue-router'
import { rememberInterfacePath, savedInterfacePath } from '@/utils/interfaceMode'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: () => savedInterfacePath() },
    { path: '/chat/:sessionId?', name: 'chat', component: () => import('@/views/ChatView.vue') },
    { path: '/history/:sessionId?', name: 'history', component: () => import('@/views/HistoryView.vue') },
    { path: '/conversations/computer/:agentId', name: 'computer', component: () => import('@/views/ComputerViewerView.vue') },
    { path: '/conversations/automations', name: 'bot-automations', component: () => import('@/views/BotAutomationsView.vue') },
    { path: '/conversations/:id?', name: 'conversations', component: () => import('@/views/ConversationsView.vue') },
    { path: '/kanban/:boardSlug?', name: 'kanban', component: () => import('@/views/KanbanView.vue') },
    { path: '/files', name: 'files', component: () => import('@/views/FilesView.vue') },
    { path: '/artifacts', redirect: '/chat' },
    { path: '/:pathMatch(.*)*', redirect: '/chat' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
router.afterEach(to => { if (to.name !== 'computer') rememberInterfacePath(to.path) })

export default router
