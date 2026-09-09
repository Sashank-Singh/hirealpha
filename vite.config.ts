import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    /* The server reads dist/.vite/manifest.json to work out which route chunk a
     * URL needs, so it can preload it alongside the entry instead of waiting
     * for the entry to parse and ask. See `preloadTags` in deploy/web-server.ts. */
    manifest: true,
  },
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/api': {
        // Point at a local API with HIREALPHA_API_TARGET, e.g. for demo mode:
        //   HIREALPHA_API_TARGET=http://localhost:8081 npm run dev
        target: process.env.HIREALPHA_API_TARGET || 'https://hirealpha.chat',
        changeOrigin: true,
      },
    },
  },
})
