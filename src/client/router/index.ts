import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // Bot mode is the only interface; retired ordinary-mode URLs land on the Bot list.
    { path: '/', redirect: '/conversations' },
    { path: '/chat/:sessionId?', redirect: '/conversations' },
    { path: '/history/:sessionId?', redirect: '/conversations' },
    { path: '/conversations/computer/:agentId', name: 'computer', component: () => import('@/views/ComputerViewerView.vue') },
    { path: '/conversations/automations', name: 'bot-automations', component: () => import('@/views/BotAutomationsView.vue') },
    { path: '/conversations/:id?', name: 'conversations', component: () => import('@/views/ConversationsView.vue') },
    { path: '/files', redirect: '/conversations' },
    { path: '/artifacts', redirect: '/conversations' },
    { path: '/:pathMatch(.*)*', redirect: '/conversations' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

export default router
