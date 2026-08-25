// vitest/config re-exports Vite's defineConfig with the `test` key typed; the
// plain vite import rejects it.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // Replaces the legacy hand-maintained sw.js, whose cache busting required
    // bumping a VERSION string and a ?v= query in two files by hand.
    //
    // injectManifest rather than the default generateSW: web push needs `push`
    // and `notificationclick` listeners in the worker, and generateSW emits
    // neither — Workbox has no opinion about what a notification looks like, so
    // there is no option that adds them. injectManifest builds src/sw.js
    // instead and only fills in its precache list, which is why that file is
    // ours to write. Everything else here is unchanged.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
      },
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
