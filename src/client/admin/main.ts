import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { setCsrfRefreshPath } from '@/api/client'
import AdminApp from './AdminApp.vue'
import '@/styles/global.css'

// The console renews its CSRF token from its own session endpoint, never the Web bootstrap.
setCsrfRefreshPath('/api/app/console/session')

const media = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => { document.documentElement.dataset.theme = media.matches ? 'dark' : 'light' }
applyTheme()
media.addEventListener('change', applyTheme)

const app = createApp(AdminApp)
app.config.errorHandler = (error, _instance, info) => console.error(`Vue render error (${info})`, error)
app.use(createPinia()).mount('#app')
