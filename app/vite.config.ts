import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // Replaces the legacy hand-maintained sw.js, whose cache busting required
    // bumping a VERSION string and a ?v= query in two files by hand.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'TEAM EYSL',
        short_name: 'TEAM EYSL',
        start_url: '/',
        display: 'standalone',
        background_color: '#f5f6f8',
        theme_color: '#f5f6f8',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
})
