import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/** Admin console bundle: built into dist/admin and served only on the admin listener (15301). */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/admin',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { input: fileURLToPath(new URL('./admin.html', import.meta.url)) },
  },
})
